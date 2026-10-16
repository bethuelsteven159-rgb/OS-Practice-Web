/**
 * Offline CLI import tool for paired PUBLIC QUESTIONS (.txt) and PRIVATE MEMO (.txt) files.
 *
 * Usage examples:
 *   npm run import -- --public path/to/practice1.public.txt --memo path/to/practice1.memo.txt
 *   npm run import -- --public path/to/practice1.public.txt
 *   npm run import -- --memo path/to/practice1.memo.txt
 *   npm run import -- --clear-fixtures
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from './config.ts';
import { ExamStore } from './db.ts';

function parseArgs(argv: string[]) {
  const out: { publicPath?: string; memoPath?: string; clearFixtures?: boolean; fixtures?: boolean; dbPath?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--public' && argv[i + 1]) out.publicPath = argv[++i];
    else if (a === '--memo' && argv[i + 1]) out.memoPath = argv[++i];
    else if (a === '--db' && argv[i + 1]) out.dbPath = argv[++i];
    else if (a === '--clear-fixtures') out.clearFixtures = true;
    else if (a === '--fixtures') out.fixtures = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig(args.dbPath ? { dbPath: path.resolve(args.dbPath) } : {});
const store = new ExamStore(cfg.dbPath);

try {
  if (args.clearFixtures) {
    const n = store.clearFixtures();
    console.log(`Cleared ${n} artificial fixture test(s) from ${cfg.dbPath}.`);
    process.exit(0);
  }

  if (args.fixtures) {
    const fDir = path.join(ROOT, 'fixtures');
    const pub = fs.readFileSync(path.join(fDir, 'artificial-fixture.public.txt'), 'utf8');
    const memo = fs.readFileSync(path.join(fDir, 'artificial-fixture.memo.txt'), 'utf8');
    const r = store.importPairTxt(pub, memo);
    if (!r.ok) {
      console.error('Fixture import failed:', r.errors);
      process.exit(1);
    }
    console.log(
      `Imported artificial developer fixture "${r.paper!.title}" (${r.paper!.testId} v${r.paper!.version}) into ${cfg.dbPath}.`,
    );
    process.exit(0);
  }

  if (!args.publicPath && !args.memoPath) {
    console.error(
      'Usage:\n' +
        '  npm run import -- --public <public_questions.txt> --memo <private_memo.txt>\n' +
        '  npm run import -- --public <public_questions.txt>\n' +
        '  npm run import -- --memo <private_memo.txt>\n' +
        '  npm run import -- --clear-fixtures',
    );
    process.exit(1);
  }

  const pubTxt = args.publicPath ? fs.readFileSync(path.resolve(args.publicPath), 'utf8') : undefined;
  const memoTxt = args.memoPath ? fs.readFileSync(path.resolve(args.memoPath), 'utf8') : undefined;

  if (pubTxt && memoTxt) {
    const r = store.importPairTxt(pubTxt, memoTxt);
    if (!r.ok) {
      console.error('Import validation failed:');
      for (const e of r.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    for (const w of r.warnings) console.warn(`  ! Warning: ${w}`);
    console.log(
      `OK: Imported "${r.paper!.title}" (testId=${r.paper!.testId}, version=${r.paper!.version}, questions=${r.paper!.questions.length}, marks=${r.paper!.totalMarks.toFixed(2)}) with validated private memo.`,
    );
  } else if (pubTxt) {
    const r = store.importPublicTxt(pubTxt);
    if (!r.ok) {
      console.error('Public file validation failed:');
      for (const e of r.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(
      `OK: Imported public questions for "${r.paper!.title}" (testId=${r.paper!.testId}, version=${r.paper!.version}). Import matching private memo before starting an attempt.`,
    );
  } else if (memoTxt) {
    const r = store.importPrivateMemoTxt(memoTxt);
    if (!r.ok) {
      console.error('Private memo validation failed:');
      for (const e of r.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(
      `OK: Imported and validated private memo for testId=${r.memo!.testId}, version=${r.memo!.version}.`,
    );
  }
} finally {
  store.close();
}
