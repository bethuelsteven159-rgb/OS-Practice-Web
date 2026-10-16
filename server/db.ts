import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  type PublicPaper,
  type PublicQuestion,
  type PublicPart,
  type PrivateMemo,
  type ValidationReport,
  parseTxtPayload,
  validatePublicPaper,
  validatePrivateMemo,
  round2,
} from './schema.ts';
import {
  type GradeState,
  type ListMark,
  grade,
  isBlank,
  canonicalTyped,
  canonicalDisplay,
} from './graders.ts';
import { type Block } from './markup.ts';

export type AttemptStatus = 'in_progress' | 'submitted' | 'timed_out';

export interface TestSummaryRow {
  testId: string;
  version: number;
  title: string;
  courseName: string | null;
  sectionName: string | null;
  durationSeconds: number;
  totalMarks: number;
  questionCount: number;
  hasMemo: boolean;
  isFixture: boolean;
  importedAt: number;
  attempts: AttemptSummaryRow[];
}

export interface AttemptSummaryRow {
  attemptId: string;
  testId: string;
  testVersion: number;
  startedAt: number;
  deadlineAt: number;
  submittedAt: number | null;
  status: AttemptStatus;
  marksAwarded: number | null;
  totalMarks: number;
}

export interface PartReviewSnapshot {
  partId: string;
  label?: string;
  state: GradeState;
  pointsAwarded: number;
  pointsPossible: number;
  rawValue: string;
  normalizedValue: string | null;
  messages: string[];
  listMarks?: ListMark[];
  feedback?: Block[] | string;
  acceptedLine: {
    kind: 'typed' | 'choice';
    displayAnswer: string;
    typedAnswer?: string;
    overrideText?: string;
  };
}

export interface QuestionReviewSnapshot {
  questionId: string;
  number: number;
  state: 'correct' | 'partial' | 'incorrect' | 'unanswered';
  pointsAwarded: number;
  pointsPossible: number;
  solution?: Block[] | string;
  comment?: Block[] | string;
  parts: Record<string, PartReviewSnapshot>;
}

export class ExamStore {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tests (
        test_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        course_name TEXT,
        section_name TEXT,
        duration_seconds INTEGER NOT NULL,
        total_marks REAL NOT NULL,
        question_count INTEGER NOT NULL,
        public_payload TEXT NOT NULL,
        has_memo INTEGER NOT NULL DEFAULT 0,
        is_fixture INTEGER NOT NULL DEFAULT 0,
        imported_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (test_id, version)
      );

      CREATE TABLE IF NOT EXISTS question_public (
        test_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        question_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        possible_marks REAL NOT NULL,
        public_content TEXT NOT NULL,
        PRIMARY KEY (test_id, version, question_id),
        FOREIGN KEY (test_id, version) REFERENCES tests(test_id, version) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS parts (
        test_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        question_id TEXT NOT NULL,
        part_id TEXT NOT NULL,
        display_order INTEGER NOT NULL,
        response_type TEXT NOT NULL,
        public_constraints TEXT NOT NULL,
        points_possible REAL NOT NULL,
        PRIMARY KEY (test_id, version, question_id, part_id),
        FOREIGN KEY (test_id, version, question_id)
          REFERENCES question_public(test_id, version, question_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS question_private (
        test_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        question_id TEXT NOT NULL,
        private_memo_payload TEXT NOT NULL,
        PRIMARY KEY (test_id, version, question_id),
        FOREIGN KEY (test_id, version) REFERENCES tests(test_id, version) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY,
        test_id TEXT NOT NULL,
        test_version INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        submitted_at INTEGER,
        status TEXT NOT NULL,
        marks_awarded REAL,
        total_marks REAL NOT NULL,
        FOREIGN KEY (test_id, test_version) REFERENCES tests(test_id, version) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS responses (
        attempt_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        part_id TEXT NOT NULL,
        raw_value TEXT NOT NULL,
        normalized_value TEXT,
        saved_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (attempt_id, question_id, part_id),
        FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS flags (
        attempt_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        flagged INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (attempt_id, question_id),
        FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS grading (
        attempt_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        part_id TEXT NOT NULL,
        points_awarded REAL NOT NULL,
        points_possible REAL NOT NULL,
        is_correct TEXT NOT NULL,
        grading_details TEXT NOT NULL,
        feedback_snapshot TEXT NOT NULL,
        PRIMARY KEY (attempt_id, question_id, part_id),
        FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS question_grading (
        attempt_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        state TEXT NOT NULL,
        points_awarded REAL NOT NULL,
        points_possible REAL NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (attempt_id, question_id),
        FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE CASCADE
      );
    `);
  }

  // ---------- Import public / private TXT files ----------

  importPublicTxt(rawTxt: string): ValidationReport & { paper?: PublicPaper } {
    const parsed = parseTxtPayload(rawTxt);
    if (!parsed.ok) return { ok: false, errors: [parsed.error], warnings: [] };
    const v = validatePublicPaper(parsed.data);
    if (!v.ok || !v.paper) return v;

    const p = v.paper;
    const now = Date.now();

    // Check if an existing memo is already stored for this (testId, version)
    const existing = this.db
      .prepare('SELECT has_memo FROM tests WHERE test_id = ? AND version = ?')
      .get(p.testId, p.version) as { has_memo: number } | undefined;

    const hasMemo = existing ? existing.has_memo : 0;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO tests (
            test_id, version, title, course_name, section_name,
            duration_seconds, total_marks, question_count, public_payload,
            has_memo, is_fixture, imported_at, active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(test_id, version) DO UPDATE SET
            title = excluded.title,
            course_name = excluded.course_name,
            section_name = excluded.section_name,
            duration_seconds = excluded.duration_seconds,
            total_marks = excluded.total_marks,
            question_count = excluded.question_count,
            public_payload = excluded.public_payload,
            is_fixture = excluded.is_fixture,
            imported_at = excluded.imported_at`,
        )
        .run(
          p.testId,
          p.version,
          p.title,
          p.courseName ?? null,
          p.sectionName ?? null,
          p.durationSeconds,
          p.totalMarks,
          p.questions.length,
          JSON.stringify(p),
          hasMemo,
          p.isFixture ? 1 : 0,
          now,
        );

      this.db.prepare('DELETE FROM question_public WHERE test_id = ? AND version = ?').run(p.testId, p.version);

      const insQ = this.db.prepare(
        `INSERT INTO question_public (test_id, version, question_id, number, possible_marks, public_content)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insP = this.db.prepare(
        `INSERT INTO parts (test_id, version, question_id, part_id, display_order, response_type, public_constraints, points_possible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const q of p.questions) {
        insQ.run(p.testId, p.version, q.id, q.number, q.marks, JSON.stringify(q));
        for (const [idx, part] of q.parts.entries()) {
          insP.run(
            p.testId,
            p.version,
            q.id,
            part.id,
            idx,
            part.type,
            JSON.stringify({
              label: part.label,
              answerInputHint: part.answerInputHint,
              choices: part.choices,
              constraints: part.constraints,
            }),
            part.marks,
          );
        }
      }

      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    return v;
  }

  importPrivateMemoTxt(rawTxt: string): ValidationReport & { memo?: PrivateMemo } {
    const parsed = parseTxtPayload(rawTxt);
    if (!parsed.ok) return { ok: false, errors: [parsed.error], warnings: [] };

    const rawObj = parsed.data as { testId?: unknown; version?: unknown } | null;
    const testId = typeof rawObj?.testId === 'string' ? rawObj.testId : '';
    const version = Number(rawObj?.version ?? 1);

    const publicPaper = testId ? this.getPublicPaper(testId, version) : null;
    if (!publicPaper) {
      return {
        ok: false,
        errors: [
          `Cannot import private memo: public questions for testId="${testId}" version=${version} have not been imported yet. Import the public questions file first or together with the memo.`,
        ],
        warnings: [],
      };
    }

    const v = validatePrivateMemo(parsed.data, publicPaper);
    if (!v.ok || !v.memo) return v;

    const memo = v.memo;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM question_private WHERE test_id = ? AND version = ?').run(memo.testId, memo.version);
      const ins = this.db.prepare(
        `INSERT INTO question_private (test_id, version, question_id, private_memo_payload)
         VALUES (?, ?, ?, ?)`,
      );
      for (const [qId, qMemo] of Object.entries(memo.questions)) {
        ins.run(memo.testId, memo.version, qId, JSON.stringify(qMemo));
      }
      this.db
        .prepare('UPDATE tests SET has_memo = 1 WHERE test_id = ? AND version = ?')
        .run(memo.testId, memo.version);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    return v;
  }

  importPairTxt(publicTxt: string, memoTxt: string): ValidationReport & { paper?: PublicPaper; memo?: PrivateMemo } {
    const pubParsed = parseTxtPayload(publicTxt);
    if (!pubParsed.ok) return { ok: false, errors: [`Public file: ${pubParsed.error}`], warnings: [] };
    const pubVal = validatePublicPaper(pubParsed.data);
    if (!pubVal.ok || !pubVal.paper) {
      return {
        ok: false,
        errors: pubVal.errors.map((e) => `Public file: ${e}`),
        warnings: pubVal.warnings,
      };
    }

    const memoParsed = parseTxtPayload(memoTxt);
    if (!memoParsed.ok) return { ok: false, errors: [`Private memo: ${memoParsed.error}`], warnings: [] };
    const memoVal = validatePrivateMemo(memoParsed.data, pubVal.paper);
    if (!memoVal.ok || !memoVal.memo) {
      return {
        ok: false,
        errors: memoVal.errors.map((e) => `Private memo: ${e}`),
        warnings: [...pubVal.warnings, ...memoVal.warnings],
      };
    }

    this.importPublicTxt(publicTxt);
    this.importPrivateMemoTxt(memoTxt);
    return {
      ok: true,
      errors: [],
      warnings: [...pubVal.warnings, ...memoVal.warnings],
      paper: pubVal.paper,
      memo: memoVal.memo,
    };
  }

  // ---------- Queries ----------

  listTests(now = Date.now()): TestSummaryRow[] {
    this.SweepExpiredAttempts(now);
    const rows = this.db
      .prepare(
        `SELECT test_id, version, title, course_name, section_name,
                duration_seconds, total_marks, question_count,
                has_memo, is_fixture, imported_at
         FROM tests
         WHERE active = 1
         ORDER BY is_fixture ASC, imported_at ASC, test_id ASC, version DESC`,
      )
      .all() as Array<{
      test_id: string;
      version: number;
      title: string;
      course_name: string | null;
      section_name: string | null;
      duration_seconds: number;
      total_marks: number;
      question_count: number;
      has_memo: number;
      is_fixture: number;
      imported_at: number;
    }>;

    return rows.map((r) => ({
      testId: r.test_id,
      version: r.version,
      title: r.title,
      courseName: r.course_name,
      sectionName: r.section_name,
      durationSeconds: r.duration_seconds,
      totalMarks: r.total_marks,
      questionCount: r.question_count,
      hasMemo: Boolean(r.has_memo),
      isFixture: Boolean(r.is_fixture),
      importedAt: r.imported_at,
      attempts: this.listAttemptsForTest(r.test_id, r.version),
    }));
  }

  listAttemptsForTest(testId: string, version?: number): AttemptSummaryRow[] {
    const rows = (
      version !== undefined
        ? this.db
            .prepare(
              `SELECT attempt_id, test_id, test_version, started_at, deadline_at,
                      submitted_at, status, marks_awarded, total_marks
               FROM attempts
               WHERE test_id = ? AND test_version = ?
               ORDER BY started_at ASC`,
            )
            .all(testId, version)
        : this.db
            .prepare(
              `SELECT attempt_id, test_id, test_version, started_at, deadline_at,
                      submitted_at, status, marks_awarded, total_marks
               FROM attempts
               WHERE test_id = ?
               ORDER BY started_at ASC`,
            )
            .all(testId)
    ) as Array<{
      attempt_id: string;
      test_id: string;
      test_version: number;
      started_at: number;
      deadline_at: number;
      submitted_at: number | null;
      status: AttemptStatus;
      marks_awarded: number | null;
      total_marks: number;
    }>;

    return rows.map((a) => ({
      attemptId: a.attempt_id,
      testId: a.test_id,
      testVersion: a.test_version,
      startedAt: a.started_at,
      deadlineAt: a.deadline_at,
      submittedAt: a.submitted_at,
      status: a.status,
      marksAwarded: a.marks_awarded,
      totalMarks: a.total_marks,
    }));
  }

  getLatestVersion(testId: string): number | null {
    const r = this.db
      .prepare('SELECT MAX(version) AS v FROM tests WHERE test_id = ? AND active = 1')
      .get(testId) as { v: number | null } | undefined;
    return r?.v ?? null;
  }

  getPublicPaper(testId: string, version?: number): PublicPaper | null {
    const v = version ?? this.getLatestVersion(testId);
    if (v == null) return null;
    const row = this.db
      .prepare('SELECT public_payload FROM tests WHERE test_id = ? AND version = ?')
      .get(testId, v) as { public_payload: string } | undefined;
    if (!row) return null;
    const paper = JSON.parse(row.public_payload) as PublicPaper;
    paper.questions.sort((a, b) => a.number - b.number);
    return paper;
  }

  hasPrivateMemo(testId: string, version?: number): boolean {
    const v = version ?? this.getLatestVersion(testId);
    if (v == null) return false;
    const row = this.db
      .prepare('SELECT has_memo FROM tests WHERE test_id = ? AND version = ?')
      .get(testId, v) as { has_memo: number } | undefined;
    return Boolean(row?.has_memo);
  }

  clearFixtures(): number {
    const res = this.db.prepare('DELETE FROM tests WHERE is_fixture = 1').run();
    return Number(res.changes ?? 0);
  }

  deleteTest(testId: string, version: number): void {
    this.db.prepare('DELETE FROM tests WHERE test_id = ? AND version = ?').run(testId, version);
  }

  // ---------- Attempt lifecycle, timer & autosave ----------

  startAttempt(testId: string, version?: number, now = Date.now()): AttemptSummaryRow {
    const v = version ?? this.getLatestVersion(testId);
    if (v == null) throw new Error(`Test "${testId}" not found.`);
    const paper = this.getPublicPaper(testId, v);
    if (!paper) throw new Error(`Test "${testId}" v${v} not found.`);
    if (!this.hasPrivateMemo(testId, v)) {
      throw new Error(
        `Cannot start a graded attempt for "${paper.title}": the matching private memo has not been imported yet.`,
      );
    }

    // If there is already an open in_progress attempt that has not expired, check it first
    this.SweepExpiredAttempts(now);

    const attemptId = crypto.randomBytes(8).toString('hex');
    const startedAt = now;
    const deadlineAt = startedAt + Math.round(paper.durationSeconds * 1000);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO attempts (
            attempt_id, test_id, test_version, started_at, deadline_at,
            submitted_at, status, marks_awarded, total_marks
          ) VALUES (?, ?, ?, ?, ?, NULL, 'in_progress', NULL, ?)`,
        )
        .run(attemptId, testId, v, startedAt, deadlineAt, paper.totalMarks);

      const insFlag = this.db.prepare(
        'INSERT INTO flags (attempt_id, question_id, flagged) VALUES (?, ?, 0)',
      );
      for (const q of paper.questions) {
        insFlag.run(attemptId, q.id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    return this.getAttempt(attemptId, now)!;
  }

  /** Check and auto-finalize any attempts whose server deadline has passed. */
  SweepExpiredAttempts(now = Date.now()): void {
    const expired = this.db
      .prepare(
        `SELECT attempt_id, deadline_at FROM attempts
         WHERE status = 'in_progress' AND deadline_at <= ?`,
      )
      .all(now) as Array<{ attempt_id: string; deadline_at: number }>;

    for (const row of expired) {
      this.finalizeAttempt(row.attempt_id, 'timed_out', row.deadline_at);
    }
  }

  getAttempt(attemptId: string, now = Date.now()): AttemptSummaryRow | null {
    const row = this.db
      .prepare(
        `SELECT attempt_id, test_id, test_version, started_at, deadline_at,
                submitted_at, status, marks_awarded, total_marks
         FROM attempts WHERE attempt_id = ?`,
      )
      .get(attemptId) as
      | {
          attempt_id: string;
          test_id: string;
          test_version: number;
          started_at: number;
          deadline_at: number;
          submitted_at: number | null;
          status: AttemptStatus;
          marks_awarded: number | null;
          total_marks: number;
        }
      | undefined;

    if (!row) return null;

    if (row.status === 'in_progress' && now >= row.deadline_at) {
      this.finalizeAttempt(row.attempt_id, 'timed_out', row.deadline_at);
      return this.getAttempt(attemptId, now);
    }

    return {
      attemptId: row.attempt_id,
      testId: row.test_id,
      testVersion: row.test_version,
      startedAt: row.started_at,
      deadlineAt: row.deadline_at,
      submittedAt: row.submitted_at,
      status: row.status,
      marksAwarded: row.marks_awarded,
      totalMarks: row.total_marks,
    };
  }

  saveResponses(
    attemptId: string,
    questionId: string,
    parts: Record<string, string>,
    now = Date.now(),
  ): { ok: boolean; expired?: boolean; revision: number; savedAt: number } {
    const att = this.getAttempt(attemptId, now);
    if (!att) throw new Error('Attempt not found.');
    if (att.status !== 'in_progress') {
      return { ok: false, expired: att.status === 'timed_out', revision: 0, savedAt: now };
    }
    const paper = this.getPublicPaper(att.testId, att.testVersion);
    const q = paper?.questions.find((x) => x.id === questionId);
    if (!q) throw new Error(`Question "${questionId}" not found.`);

    const validPartIds = new Set(q.parts.map((p) => p.id));
    let maxRev = 1;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.db.prepare(
        `INSERT INTO responses (attempt_id, question_id, part_id, raw_value, normalized_value, saved_at, revision)
         VALUES (?, ?, ?, ?, NULL, ?, 1)
         ON CONFLICT(attempt_id, question_id, part_id) DO UPDATE SET
           raw_value = excluded.raw_value,
           saved_at = excluded.saved_at,
           revision = responses.revision + 1`,
      );
      const getRev = this.db.prepare(
        'SELECT revision FROM responses WHERE attempt_id = ? AND question_id = ? AND part_id = ?',
      );

      for (const [partId, val] of Object.entries(parts)) {
        if (!validPartIds.has(partId)) continue;
        upsert.run(attemptId, questionId, partId, String(val ?? ''), now);
        const r = getRev.get(attemptId, questionId, partId) as { revision: number } | undefined;
        if (r && r.revision > maxRev) maxRev = r.revision;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    return { ok: true, revision: maxRev, savedAt: now };
  }

  toggleFlag(attemptId: string, questionId: string, flagged?: boolean): boolean {
    const att = this.db
      .prepare('SELECT attempt_id FROM attempts WHERE attempt_id = ?')
      .get(attemptId) as { attempt_id: string } | undefined;
    if (!att) throw new Error('Attempt not found.');

    const cur = this.db
      .prepare('SELECT flagged FROM flags WHERE attempt_id = ? AND question_id = ?')
      .get(attemptId, questionId) as { flagged: number } | undefined;

    const next = flagged !== undefined ? (flagged ? 1 : 0) : cur?.flagged ? 0 : 1;
    this.db
      .prepare(
        `INSERT INTO flags (attempt_id, question_id, flagged) VALUES (?, ?, ?)
         ON CONFLICT(attempt_id, question_id) DO UPDATE SET flagged = excluded.flagged`,
      )
      .run(attemptId, questionId, next);
    return Boolean(next);
  }

  getAttemptResponses(attemptId: string): Record<string, Record<string, string>> {
    const rows = this.db
      .prepare('SELECT question_id, part_id, raw_value FROM responses WHERE attempt_id = ?')
      .all(attemptId) as Array<{ question_id: string; part_id: string; raw_value: string }>;

    const out: Record<string, Record<string, string>> = {};
    for (const r of rows) {
      if (!out[r.question_id]) out[r.question_id] = {};
      out[r.question_id][r.part_id] = r.raw_value;
    }
    return out;
  }

  getAttemptFlags(attemptId: string): Record<string, boolean> {
    const rows = this.db
      .prepare('SELECT question_id, flagged FROM flags WHERE attempt_id = ?')
      .all(attemptId) as Array<{ question_id: string; flagged: number }>;
    const out: Record<string, boolean> = {};
    for (const r of rows) out[r.question_id] = Boolean(r.flagged);
    return out;
  }

  /** Compute neutral per-question answer status during an active sitting (never reveals correctness). */
  getQuestionAttemptStatus(
    q: PublicQuestion,
    qResponses: Record<string, string> | undefined,
  ): { state: 'unanswered' | 'incomplete' | 'saved'; label: string } {
    const r = qResponses ?? {};
    let answered = 0;
    for (const p of q.parts) {
      if (!isBlank(r[p.id])) answered++;
    }
    if (answered === 0) return { state: 'unanswered', label: 'Not yet answered' };
    if (answered < q.parts.length) return { state: 'incomplete', label: 'Incomplete answer' };
    return { state: 'saved', label: 'Answer saved' };
  }

  // ---------- Atomic submission & deterministic server-side grading ----------

  submitAttempt(attemptId: string, now = Date.now()): AttemptSummaryRow {
    const att = this.getAttempt(attemptId, now);
    if (!att) throw new Error('Attempt not found.');
    if (att.status !== 'in_progress') {
      return att;
    }
    return this.finalizeAttempt(attemptId, 'submitted', now);
  }

  private finalizeAttempt(
    attemptId: string,
    finalStatus: 'submitted' | 'timed_out',
    submittedAt: number,
  ): AttemptSummaryRow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          `SELECT attempt_id, test_id, test_version, status
           FROM attempts WHERE attempt_id = ?`,
        )
        .get(attemptId) as
        | { attempt_id: string; test_id: string; test_version: number; status: AttemptStatus }
        | undefined;

      if (!row) throw new Error('Attempt not found.');
      if (row.status !== 'in_progress') {
        this.db.exec('COMMIT');
        return this.getAttempt(attemptId, submittedAt)!;
      }

      const paper = this.getPublicPaper(row.test_id, row.test_version);
      if (!paper) throw new Error('Public paper missing during grading.');

      const memoRows = this.db
        .prepare('SELECT question_id, private_memo_payload FROM question_private WHERE test_id = ? AND version = ?')
        .all(row.test_id, row.test_version) as Array<{ question_id: string; private_memo_payload: string }>;
      const memoByQ: Record<string, PrivateMemo['questions'][string]> = {};
      for (const mr of memoRows) {
        memoByQ[mr.question_id] = JSON.parse(mr.private_memo_payload);
      }

      const responses = this.getAttemptResponses(attemptId);

      const insPartGrade = this.db.prepare(
        `INSERT INTO grading (
          attempt_id, question_id, part_id, points_awarded, points_possible,
          is_correct, grading_details, feedback_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id, question_id, part_id) DO NOTHING`,
      );
      const updResponseNorm = this.db.prepare(
        `UPDATE responses SET normalized_value = ?
         WHERE attempt_id = ? AND question_id = ? AND part_id = ?`,
      );
      const insQGrade = this.db.prepare(
        `INSERT INTO question_grading (
          attempt_id, question_id, number, state, points_awarded, points_possible, snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id, question_id) DO NOTHING`,
      );

      let totalAwarded = 0;

      for (const q of paper.questions) {
        const qMemo = memoByQ[q.id];
        if (!qMemo) throw new Error(`Missing private memo for question "${q.id}".`);

        const qResp = responses[q.id] ?? {};
        const partSnapshots: Record<string, PartReviewSnapshot> = {};
        let qAwarded = 0;
        let anyAnswered = false;

        for (const part of q.parts) {
          const pMemo = qMemo.parts[part.id];
          if (!pMemo) throw new Error(`Missing private memo for part "${q.id}.${part.id}".`);

          const rawVal = qResp[part.id] ?? '';
          if (!isBlank(rawVal)) anyAnswered = true;

          const choiceIds = part.choices?.map((c) => c.id);
          const gRes = grade(pMemo.grader, rawVal, { choiceIds });
          const pts = round2(Math.min(part.marks, Math.max(0, gRes.fraction * part.marks)));
          qAwarded += pts;

          if (gRes.normalized !== null) {
            updResponseNorm.run(gRes.normalized, attemptId, q.id, part.id);
          }

          const acceptedLine = buildAcceptedLine(part, pMemo);
          const snap: PartReviewSnapshot = {
            partId: part.id,
            label: part.label,
            state: gRes.state,
            pointsAwarded: pts,
            pointsPossible: part.marks,
            rawValue: rawVal,
            normalizedValue: gRes.normalized,
            messages: gRes.messages,
            listMarks: gRes.listMarks,
            feedback: pMemo.feedback,
            acceptedLine,
          };
          partSnapshots[part.id] = snap;

          insPartGrade.run(
            attemptId,
            q.id,
            part.id,
            pts,
            part.marks,
            gRes.state,
            JSON.stringify({ normalized: gRes.normalized, messages: gRes.messages, listMarks: gRes.listMarks }),
            JSON.stringify(snap),
          );
        }

        qAwarded = round2(Math.min(q.marks, Math.max(0, qAwarded)));
        totalAwarded += qAwarded;

        const qState: QuestionReviewSnapshot['state'] =
          qAwarded >= q.marks - 1e-6
            ? 'correct'
            : qAwarded > 0
              ? 'partial'
              : anyAnswered
                ? 'incorrect'
                : 'unanswered';

        const qSnap: QuestionReviewSnapshot = {
          questionId: q.id,
          number: q.number,
          state: qState,
          pointsAwarded: qAwarded,
          pointsPossible: q.marks,
          solution: qMemo.solution,
          comment: qMemo.comment,
          parts: partSnapshots,
        };

        insQGrade.run(attemptId, q.id, q.number, qState, qAwarded, q.marks, JSON.stringify(qSnap));
      }

      totalAwarded = round2(totalAwarded);

      this.db
        .prepare(
          `UPDATE attempts
           SET status = ?, submitted_at = ?, marks_awarded = ?
           WHERE attempt_id = ?`,
        )
        .run(finalStatus, submittedAt, totalAwarded, attemptId);

      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    return this.getAttempt(attemptId, submittedAt)!;
  }

  /**
   * Retrieve review snapshots ONLY if the attempt has been finalized (`submitted` or `timed_out`).
   * Throws an error if called on an `in_progress` attempt so private memo data can never leak early.
   */
  getReviewSnapshots(attemptId: string, now = Date.now()): Record<string, QuestionReviewSnapshot> {
    const att = this.getAttempt(attemptId, now);
    if (!att) throw new Error('Attempt not found.');
    if (att.status === 'in_progress') {
      throw new Error('Forbidden: review data is locked while the attempt is in progress.');
    }

    const rows = this.db
      .prepare('SELECT question_id, snapshot_json FROM question_grading WHERE attempt_id = ?')
      .all(attemptId) as Array<{ question_id: string; snapshot_json: string }>;

    const out: Record<string, QuestionReviewSnapshot> = {};
    for (const r of rows) {
      out[r.question_id] = JSON.parse(r.snapshot_json);
    }
    return out;
  }
}

function buildAcceptedLine(
  part: PublicPart,
  pMemo: PrivateMemo['questions'][string]['parts'][string],
): PartReviewSnapshot['acceptedLine'] {
  if (pMemo.acceptedAnswerLine) {
    return {
      kind: 'typed',
      displayAnswer: canonicalDisplay(pMemo.grader),
      typedAnswer: canonicalTyped(pMemo.grader),
      overrideText: pMemo.acceptedAnswerLine,
    };
  }
  if (pMemo.grader.type === 'choice') {
    const opt = part.choices?.find((c) => c.id === (pMemo.grader as { answer: string }).answer);
    return {
      kind: 'choice',
      displayAnswer: opt ? opt.label : (pMemo.grader as { answer: string }).answer,
    };
  }
  if (pMemo.grader.type === 'multichoice') {
    const ansSet = new Set(pMemo.grader.answers);
    const labels = (part.choices ?? []).filter((c) => ansSet.has(c.id)).map((c) => c.label);
    return {
      kind: 'choice',
      displayAnswer: labels.join('; '),
    };
  }
  return {
    kind: 'typed',
    displayAnswer: canonicalDisplay(pMemo.grader),
    typedAnswer: canonicalTyped(pMemo.grader),
  };
}
