import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { grade } from '../../server/graders.ts';
import {
  parseTxtPayload,
  validatePublicPaper,
  validatePrivateMemo,
} from '../../server/schema.ts';
import { ExamStore } from '../../server/db.ts';
import { createApp } from '../../server/app.ts';
import { loadConfig, ROOT } from '../../server/config.ts';

describe('1. Deterministic Marking Engine (graders.ts)', () => {
  test('Integer grader trims whitespace, handles sign, rejects decimals/units, distinguishes blank', () => {
    const g = { type: 'integer' as const, answer: 112 };
    assert.equal(grade(g, '112').state, 'correct');
    assert.equal(grade(g, '  +112 ').state, 'correct');
    assert.equal(grade(g, '112').normalized, '112');
    assert.equal(grade(g, '113').state, 'incorrect');
    assert.equal(grade(g, '112 ms').state, 'invalid');
    assert.equal(grade(g, '112.0').state, 'invalid');
    assert.equal(grade(g, '   ').state, 'blank');
  });

  test('Decimal grader compares numerically with tolerance and supports ratios', () => {
    const g = { type: 'decimal' as const, answer: 2.5, absTol: 0.01 };
    assert.equal(grade(g, '2.500').state, 'correct');
    assert.equal(grade(g, '2.505').state, 'correct');
    assert.equal(grade(g, '5/2').state, 'correct');
    assert.equal(grade(g, '2.55').state, 'incorrect');
    assert.equal(grade(g, '2.5 KB').state, 'invalid');
  });

  test('Binary mask grader enforces exact bit width and preserves leading zeroes', () => {
    const g = { type: 'binary' as const, answer: '00001011010110', width: 14 };
    assert.equal(grade(g, '00001011010110').state, 'correct');
    // Same integer value without leading zeroes must fail width check
    const short = grade(g, '1011010110');
    assert.equal(short.state, 'incorrect');
    assert.equal(short.fraction, 0);
    assert.match(short.messages[0], /14.*10/);
    assert.equal(grade(g, '00001011010112').state, 'invalid');
  });

  test('List/array grader parses brackets, checks length, order, nested pairs, and positional partial credit', () => {
    const gExact = {
      type: 'list' as const,
      answer: [0, 1, 2, 3],
      items: 'integer' as const,
      ordered: true,
      partial: 'none' as const,
    };
    const rOk = grade(gExact, '[0,1,2,3]');
    assert.equal(rOk.state, 'correct');
    assert.equal(rOk.normalized, '[0, 1, 2, 3]');

    // Wrong length produces STACK-style diagnostic
    const rLen = grade(gExact, '[0,1,2,3,4]');
    assert.equal(rLen.state, 'incorrect');
    assert.match(rLen.messages[0], /should have \\\(4\\\) elements, but it actually has \\\(5\\\)/);

    // Positional partial credit
    const gPartial = {
      type: 'list' as const,
      answer: [10, 20, 30, 40],
      items: 'integer' as const,
      ordered: true,
      partial: 'positional' as const,
    };
    const rPart = grade(gPartial, '[10, 99, 30, 88]');
    assert.equal(rPart.state, 'partial');
    assert.equal(rPart.fraction, 0.5);
    assert.deepEqual(
      rPart.listMarks?.map((m) => m.ok),
      [true, false, true, false],
    );

    // Nested [address, length] pairs
    const gNested = {
      type: 'list' as const,
      answer: [
        [100, 20],
        [300, 40],
      ],
      items: 'integer' as const,
      ordered: true,
    };
    assert.equal(grade(gNested, '[[100, 20], [300, 40]]').state, 'correct');
    assert.equal(grade(gNested, '[[100, 20], [300, 99]]').state, 'incorrect');
  });

  test('Dropdown / choice and multichoice graders grade by stable option ID', () => {
    const gChoice = { type: 'choice' as const, answer: 'opt_correct' };
    assert.equal(
      grade(gChoice, 'opt_correct', { choiceIds: ['opt_correct', 'opt_wrong'] }).state,
      'correct',
    );
    assert.equal(
      grade(gChoice, 'opt_wrong', { choiceIds: ['opt_correct', 'opt_wrong'] }).state,
      'incorrect',
    );
    assert.equal(
      grade(gChoice, 'opt_hacked', { choiceIds: ['opt_correct', 'opt_wrong'] }).state,
      'invalid',
    );
  });
});

describe('2. Paired TXT Schema & Import Validation (schema.ts + db.ts)', () => {
  test('Accepts valid JSON-in-TXT and tagged-TXT pairs, rejects mismatched IDs/marks or leaked answers', () => {
    const pubTxt = fs.readFileSync(path.join(ROOT, 'fixtures', 'artificial-fixture.public.txt'), 'utf8');
    const memoTxt = fs.readFileSync(path.join(ROOT, 'fixtures', 'artificial-fixture.memo.txt'), 'utf8');

    const store = new ExamStore(':memory:');
    const res = store.importPairTxt(pubTxt, memoTxt);
    assert.equal(res.ok, true, `Expected valid fixture pair, got: ${res.errors.join('; ')}`);

    // Contradictory totalMarks must be rejected
    const badPub = JSON.parse(pubTxt);
    badPub.totalMarks = 999;
    const badRes = validatePublicPaper(badPub);
    assert.equal(badRes.ok, false);
    assert.match(badRes.errors.join(' '), /totalMarks/);

    // Leaked answer field in public question must be rejected
    const leakedPub = JSON.parse(pubTxt);
    leakedPub.questions[0].parts[0].answer = 112;
    const leakedRes = validatePublicPaper(leakedPub);
    assert.equal(leakedRes.ok, false);
    assert.match(leakedRes.errors.join(' '), /must not contain private field "answer"/);

    // Mismatched memo question ID must be rejected
    const badMemo = JSON.parse(memoTxt);
    badMemo.questions.non_existent_q = badMemo.questions.q1;
    delete badMemo.questions.q1;
    const badMemoRes = validatePrivateMemo(badMemo, res.paper);
    assert.equal(badMemoRes.ok, false);
    assert.match(badMemoRes.errors.join(' '), /unknown question id|missing question/);

    // Tagged plain-text format also parses and validates
    const taggedPublic = `=== OS-PRACTICE-PUBLIC v1 ===
testId: tagged-demo
version: 1
title: Tagged Format Demo
durationSeconds: 7200
totalMarks: 2
--- QUESTION q1 | number=1 | marks=2 ---
Synthetic tagged question stem.
--- PART a | label=(a) | type=integer | marks=2 | hint=(a whole number) ---
Enter 42:`;
    const taggedMemo = `=== OS-PRACTICE-MEMO v1 ===
testId: tagged-demo
version: 1
totalMarks: 2
--- QUESTION q1 ---
Synthetic tagged worked solution.
--- PART a | marks=2 | grader=integer | answer=42 ---
Synthetic tagged part feedback.`;

    const tagImport = store.importPairTxt(taggedPublic, taggedMemo);
    assert.equal(tagImport.ok, true, tagImport.errors.join('; '));
    store.close();
  });
});

describe('3. Full Lifecycle, Timer Authority, Secrecy & 5-Paper Coexistence', () => {
  test('Enforces memo requirement before start, keeps memo secret during attempt, persists timer, auto-expires, and supports 5 papers', async () => {
    let fakeNow = 1_700_000_000_000;
    const cfg = loadConfig({ dbPath: ':memory:', port: 0 });
    const app = createApp(cfg, () => fakeNow);

    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const addr = app.server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Empty state shows "No test imported"
      const emptyRes = await fetch(`${baseUrl}/practice`);
      const emptyHtml = await emptyRes.text();
      assert.match(emptyHtml, /No test imported/);

      // 2. Import public paper WITHOUT memo -> cannot start attempt yet
      const basePub = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'fixtures', 'artificial-fixture.public.txt'), 'utf8'),
      );
      const baseMemo = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'fixtures', 'artificial-fixture.memo.txt'), 'utf8'),
      );

      app.store.importPublicTxt(JSON.stringify(basePub));
      assert.equal(app.store.hasPrivateMemo(basePub.testId, 1), false);
      assert.throws(() => app.store.startAttempt(basePub.testId, 1, fakeNow), /private memo has not been imported/);

      // 3. Import 5 distinct practice papers (practice-1 .. practice-5)
      for (let i = 1; i <= 5; i++) {
        const pub = { ...basePub, testId: `practice-${i}`, title: `Synthetic Practice Paper ${i}`, isFixture: false };
        const memo = { ...baseMemo, testId: `practice-${i}` };
        const r = app.store.importPairTxt(JSON.stringify(pub), JSON.stringify(memo));
        assert.equal(r.ok, true);
      }
      const allTests = app.store.listTests(fakeNow);
      assert.equal(allTests.filter((t) => t.testId.startsWith('practice-')).length, 5);

      // 4. Start an attempt on practice-1 (default 2 hours = 7200s)
      const att = app.store.startAttempt('practice-1', 1, fakeNow);
      assert.equal(att.status, 'in_progress');
      assert.equal(att.deadlineAt - att.startedAt, 7200 * 1000);

      // 5. Verify secrecy during active attempt: HTML page and API must NOT leak memo answers or feedback
      const q1Res = await fetch(`${baseUrl}/practice/practice-1/attempt/${att.attemptId}/question/1`);
      const q1Html = await q1Res.text();
      assert.doesNotMatch(q1Html, /Synthetic explanation/);
      assert.doesNotMatch(q1Html, /Your last answer was interpreted as follows/);
      assert.doesNotMatch(q1Html, /would be correct/);

      // Review endpoint must return 403 while in_progress
      const forbiddenReview = await fetch(`${baseUrl}/api/attempts/${att.attemptId}/review`);
      assert.equal(forbiddenReview.status, 403);

      // 6. Autosave Q1 -> navigate Q2 -> back to Q1 preserves answers & flags
      app.store.saveResponses(att.attemptId, 'q1', { a: '112', b: 'opt_alpha' }, fakeNow);
      app.store.saveResponses(att.attemptId, 'q2', { a: '35', b: '999', c: '101101' }, fakeNow); // q2.a right (1), q2.b wrong (0), q2.c wrong width (0)
      app.store.saveResponses(att.attemptId, 'q3', { a: '[10, 99, 30, 40]', b: '[1, 3, 2, 4]' }, fakeNow); // q3.a 3/4 * 3 = 2.25, q3.b 2
      app.store.toggleFlag(att.attemptId, 'q2', true);

      // Advance clock by 30 minutes -> timer never resets on reload
      fakeNow += 1800 * 1000;
      const statusRes = await fetch(`${baseUrl}/api/attempts/${att.attemptId}/status`);
      const statusJson = (await statusRes.json()) as { remainingSeconds: number };
      assert.equal(statusJson.remainingSeconds, 5400);

      // 7. Submit attempt -> computes partial credit deterministically and locks answers
      const submitted = app.store.submitAttempt(att.attemptId, fakeNow);
      assert.equal(submitted.status, 'submitted');
      // Expected score: q1 = 1 + 1 = 2; q2 = 1 + 0 + 0 = 1; q3 = 2.25 + 2 = 4.25 -> total = 7.25 / 10.00
      assert.equal(submitted.marksAwarded, 7.25);

      // Saving after submit is rejected
      const lateSave = app.store.saveResponses(att.attemptId, 'q1', { a: '0', b: 'opt_beta' }, fakeNow);
      assert.equal(lateSave.ok, false);
      assert.equal(app.store.getAttemptResponses(att.attemptId).q1.a, '112');

      // 8. Review page now unlocks white interpretation strip, cream outcome panel, and accepted answers
      const revRes = await fetch(`${baseUrl}/practice/practice-1/attempt/${att.attemptId}/review/1`);
      const revHtml = await revRes.text();
      assert.match(revHtml, /Your last answer was interpreted as follows:/);
      assert.match(revHtml, /Correct answer, well done\./);
      assert.match(revHtml, /which can be typed as/);

      // 9. Test automatic timeout on practice-2
      const att2 = app.store.startAttempt('practice-2', 1, fakeNow);
      app.store.saveResponses(att2.attemptId, 'q1', { a: '112', b: '' }, fakeNow);
      // Jump past 2-hour deadline
      fakeNow += 7201 * 1000;
      const expiredAtt = app.store.getAttempt(att2.attemptId, fakeNow)!;
      assert.equal(expiredAtt.status, 'timed_out');
      assert.equal(expiredAtt.marksAwarded, 1);
    } finally {
      app.server.close();
      app.store.close();
    }
  });
});
