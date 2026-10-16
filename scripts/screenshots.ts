import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.ts';
import { loadConfig, ROOT } from '../server/config.ts';

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

async function main() {
  const outDir = path.join(ROOT, 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });

  const cfg = loadConfig({ dbPath: ':memory:', port: 0 });
  const app = createApp(cfg);

  // Build a 23-question synthetic non-OS fixture so the 7-column Quiz navigation grid (rows 1-7, 8-14, 15-21, 22-23)
  // and multi-part layout can be compared directly against the 1365x768 reference screenshots.
  const questions = [];
  const memoQuestions: Record<string, unknown> = {};

  for (let n = 1; n <= 23; n++) {
    const qId = `q${n}`;
    if (n === 23) {
      questions.push({
        id: qId,
        number: 23,
        marks: 2,
        stem: [
          'A synthetic user-space loop executes with no external handlers, doing nothing else:',
          {
            type: 'code',
            boxed: false,
            text: 'unsigned long long iterations = 0;\nwhile (!stop_requested) {\n    iterations++;\n}',
          },
          'It runs for **1123 ms** before it is stopped. The periodic tick is configured to fire every **10 ms**.',
        ],
        parts: [
          {
            id: 'a',
            label: '(a)',
            type: 'integer',
            marks: 1,
            prompt: 'How many periodic ticks are delivered during the synthetic run?',
            inputWidth: 11,
          },
          {
            id: 'b',
            label: '(b)',
            type: 'dropdown',
            marks: 1,
            prompt: 'This synthetic loop makes no voluntary calls. What transfers control periodically in the simulator?',
            choices: [
              {
                id: 'c_right',
                label: 'The periodic tick transfers control to the kernel regardless of what the loop is executing, so the coordinator gets a chance to run whatever the program does',
              },
              {
                id: 'c_wrong',
                label: 'Nothing transfers control until the loop terminates on its own',
              },
            ],
          },
        ],
      });
      memoQuestions[qId] = {
        solution: [
          '\\(112\\) ticks: \\(1123\\) ms contains \\(112\\) whole \\(10\\) ms intervals, with \\(3\\) ms left over — not long enough for one more.',
          'The counter tells the synthetic program **nothing** about them. This property is called **transparency**, and it is what makes the abstraction believable. The saved frame captured the complete execution context on the way in — counter, registers, stack pointer, mode bit — and restored all of it on the way out. The registers hold what they held, its stack is unchanged, and the next instruction it executes is the one it expected to execute.',
          'So a user program cannot directly count periodic ticks, and cannot tell from its restored execution context whether it was suspended for a microsecond or for a second.',
        ],
        parts: {
          a: { marks: 1, grader: { type: 'integer', answer: 112 } },
          b: { marks: 1, grader: { type: 'choice', answer: 'c_right' } },
        },
      };
    } else if (n === 2) {
      questions.push({
        id: qId,
        number: 2,
        marks: 3,
        stem: [
          'This runs on a synthetic Pep/8-style machine. `,i` is immediate addressing (the number in the instruction *is* the value) and `,d` is direct addressing (the operand names a memory location). `BRLE` branches when the accumulator is less than or equal to zero; `BR` always branches.',
          {
            type: 'code',
            boxed: true,
            text: '      LDA    11,i\n      STA    total,d\n      LDA    4,i\n      STA    count,d\nloop: LDA    count,d\n      BRLE   done\n      LDA    total,d\n      ADDA   6,i\n      STA    total,d\n      LDA    count,d\n      SUBA   1,i\n      STA    count,d\n      BR     loop\ndone: STOP\n      total: .BLOCK 2\n      count: .BLOCK 2\n      .END',
          },
          'The loop body executes exactly **4** times.',
        ],
        parts: [
          {
            id: 'a',
            label: '(a)',
            type: 'integer',
            marks: 1,
            prompt: 'What value is stored at `total` when the synthetic program halts?',
          },
          {
            id: 'b',
            label: '(b)',
            type: 'integer',
            marks: 1,
            prompt: 'How many cycles does *one complete pass* round the loop take, counting from `LDA count,d` at `loop:` up to and including `BR loop`?',
          },
          {
            id: 'c',
            label: '(c)',
            type: 'integer',
            marks: 1,
            prompt: 'How many cycles does the whole synthetic program perform, from the first instruction to `STOP` inclusive?',
          },
        ],
      });
      memoQuestions[qId] = {
        solution: ['Four setup instructions, then \\(4\\) complete passes, then the final pass through `loop:` that fails the test, then `STOP`.'],
        parts: {
          a: { marks: 1, grader: { type: 'integer', answer: 35 } },
          b: {
            marks: 1,
            grader: {
              type: 'integer',
              answer: 9,
              partialAccept: [{ answer: 7, fraction: 0.4 }],
            },
            feedback: ['The two instructions at `loop:` — reloading the counter and testing it — are part of the pass too.'],
          },
          c: { marks: 1, grader: { type: 'integer', answer: 43 } },
        },
      };
    } else {
      questions.push({
        id: qId,
        number: n,
        marks: 2,
        stem: [`[Synthetic Placeholder Question ${n}]`],
        parts: [
          { id: 'a', label: '(a)', type: 'integer', marks: 1, prompt: 'Part (a):' },
          { id: 'b', label: '(b)', type: 'integer', marks: 1, prompt: 'Part (b):' },
        ],
      });
      memoQuestions[qId] = {
        solution: [`Synthetic solution for question ${n}.`],
        parts: {
          a: { marks: 1, grader: { type: 'integer', answer: 10 } },
          b: { marks: 1, grader: { type: 'integer', answer: 20 } },
        },
      };
    }
  }

  const totalMarks = questions.reduce((s, q) => s + q.marks, 0);
  const pubPaper = {
    schemaVersion: '1.0',
    kind: 'public_questions',
    testId: 'visual-check',
    version: 1,
    title: 'Practice Layout Verification Paper (Synthetic)',
    courseName: 'COMS3010A-OS-SM2-2026',
    sectionName: 'Test 1 & Test 2',
    durationSeconds: 7200,
    totalMarks,
    isFixture: true,
    questions,
  };
  const privMemo = {
    schemaVersion: '1.0',
    kind: 'private_memo',
    testId: 'visual-check',
    version: 1,
    totalMarks,
    questions: memoQuestions,
  };

  const imp = app.store.importPairTxt(JSON.stringify(pubPaper), JSON.stringify(privMemo));
  if (!imp.ok) throw new Error(imp.errors.join('; '));

  const att = app.store.startAttempt('visual-check', 1);

  // Set responses so that tiles 1, 15, 23 are green (correct), tiles 4, 7, 9, 12, 18 are red (incorrect), and others are amber (partial)
  const greenSet = new Set([1, 15, 23]);
  const redSet = new Set([4, 7, 9, 12, 18]);

  for (let n = 1; n <= 23; n++) {
    const qId = `q${n}`;
    if (n === 23) {
      app.store.saveResponses(att.attemptId, qId, { a: '112', b: 'c_right' });
    } else if (n === 2) {
      app.store.saveResponses(att.attemptId, qId, { a: '35', b: '7', c: '34' });
    } else if (greenSet.has(n)) {
      app.store.saveResponses(att.attemptId, qId, { a: '10', b: '20' });
    } else if (redSet.has(n)) {
      app.store.saveResponses(att.attemptId, qId, { a: '0', b: '0' });
    } else {
      app.store.saveResponses(att.attemptId, qId, { a: '10', b: '0' });
    }
  }

  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    executablePath: findChromePath(),
    headless: true,
  });

  try {
    // 1. Capture Attempt View at 1365x650 (matching the website area beneath Chrome's 118px top bar in the 1365x768 screenshot) and full 1365x768
    const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
    await page.goto(`${baseUrl}/practice/visual-check/attempt/${att.attemptId}/question/23`);
    await page.screenshot({ path: path.join(outDir, 'attempt-1365x768.png') });

    // 2. Submit and capture Review View at 1365x768 and 1440x900
    app.store.submitAttempt(att.attemptId);

    await page.goto(`${baseUrl}/practice/visual-check/attempt/${att.attemptId}/review/23`);
    await page.screenshot({ path: path.join(outDir, 'review-q23-top-1365x768.png') });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.screenshot({ path: path.join(outDir, 'review-q23-bottom-1365x768.png') });

    await page.goto(`${baseUrl}/practice/visual-check/attempt/${att.attemptId}/review/2`);
    await page.screenshot({ path: path.join(outDir, 'review-q2-1365x768.png') });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/practice/visual-check/attempt/${att.attemptId}/review/23`);
    await page.screenshot({ path: path.join(outDir, 'review-q23-1440x900.png') });

    console.log('Saved screenshots to', outDir);
  } finally {
    await browser.close();
    app.server.close();
    app.store.close();
  }
}

main();
