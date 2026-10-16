import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../../server/app.ts';
import { loadConfig, ROOT } from '../../server/config.ts';

function findChromePath(): string {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.CHROME_PATH ?? '',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('Chrome executable not found.');
}

test('End-to-End Browser Flow: start -> answer -> navigate -> flag -> submit -> review', async () => {
  const cfg = loadConfig({ dbPath: ':memory:', port: 0 });
  const app = createApp(cfg);

  const pubTxt = fs.readFileSync(path.join(ROOT, 'fixtures', 'artificial-fixture.public.txt'), 'utf8');
  const memoTxt = fs.readFileSync(path.join(ROOT, 'fixtures', 'artificial-fixture.memo.txt'), 'utf8');
  app.store.importPairTxt(pubTxt, memoTxt);

  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    executablePath: findChromePath(),
    headless: true,
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 768 } });
    const page = await context.newPage();

    // 1. Open library and click into the test
    await page.goto(`${baseUrl}/practice`);
    await page.click('text=ARTIFICIAL UI FIXTURE');

    // 2. Click "Attempt quiz now"
    await page.click('button:has-text("Attempt quiz now")');
    await page.waitForURL(/\/attempt\/[^/]+\/question\/1$/);

    // Verify one-question-per-page (Q1 visible, Q2 not on page)
    const qnoText = await page.locator('.que-info .qno-line').innerText();
    assert.match(qnoText, /Question\s*1/);

    // Verify no review outcome panel is visible during attempt
    assert.equal(await page.locator('.outcome').count(), 0);

    // 3. Enter answers on Q1
    await page.fill('[data-part-id="a"] input', '112');
    await page.selectOption('[data-part-id="b"] select', 'opt_alpha');

    // Toggle flag on Q1
    await page.click('#flag-question-btn');
    await page.waitForSelector('.qnbutton[data-question-id="q1"].flagged');

    // 4. Navigate to Q2 via Next page link (triggers autosave before navigation)
    await page.click('a.nav-next');
    await page.waitForURL(/\/attempt\/[^/]+\/attempt\/2$/);

    // Answer Q2 partially
    await page.fill('[data-part-id="a"] input', '35');
    await page.fill('[data-part-id="b"] input', '2.5');
    await page.fill('[data-part-id="c"] input', '101101'); // wrong bit-width (6 instead of 8)

    // 5. Navigate back to Q1 via Quiz navigation tile 1 and verify answers persisted
    await page.click('.qnbutton[data-question-id="q1"]');
    await page.waitForURL(/\/attempt\/[^/]+\/attempt\/1$/);
    assert.equal(await page.inputValue('[data-part-id="a"] input'), '112');
    assert.equal(await page.inputValue('[data-part-id="b"] select'), 'opt_alpha');

    // 6. Click "Finish attempt..." in right Quiz navigation
    await page.click('.othernav a:has-text("Finish attempt")');
    await page.waitForURL(/\/finish$/);

    // Submit all and finish
    await page.click('button:has-text("Submit all and finish")');
    await page.waitForURL(/\/summary$/);

    // Verify summary table shows Marks and Grade
    const summaryText = await page.locator('.quiz-summary-table').innerText();
    assert.match(summaryText, /Finished/);
    assert.match(summaryText, /4\.00\/10\.00/);
    assert.match(summaryText, /40\.00 out of 100\.00/);

    // 7. Enter Review mode
    await page.click('a:has-text("Review attempt")');
    await page.waitForURL(/\/review\/1$/);

    // Verify readonly input, white interpretation strip, and cream outcome panel on Q1
    assert.equal(await page.getAttribute('[data-part-id="a"] input', 'readonly'), '');
    const interpVal = await page.locator('.stack-interp-value').first().innerText();
    assert.equal(interpVal.trim(), '112');

    const outcomeText = await page.locator('.outcome').innerText();
    assert.match(outcomeText, /Correct answer, well done\./);
    assert.match(outcomeText, /The answer 112, which can be typed as 112, would be correct\./);
  } finally {
    await browser.close();
    app.server.close();
    app.store.close();
  }
});
