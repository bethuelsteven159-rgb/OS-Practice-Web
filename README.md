# OS Practice Test Website (Moodle + STACK Simulator)

A local, private, one-question-per-page practice-exam web application reproducing the visual appearance and behavior of the Wits Moodle 4 Boost + STACK quiz interface.

- **One question per page** — enforced during both active sittings and post-submission review.
- **Authoritative 2-hour server countdown** — configurable per paper (`durationSeconds`, default `7200` seconds = `2:00:00`), persisted in SQLite (`data/app.db`) so refreshing, navigating, or reopening the browser never resets the deadline.
- **Autosave & question flagging** — debounced autosave while typing plus immediate flush on blur and page navigation.
- **Strict memo secrecy** — private answers, grading rules, and worked solutions live only in the local SQLite backend and are never sent to the browser until an attempt is finalized (`submitted` or `timed_out`).
- **Deterministic auto-marking** — supports integers, decimals/ratios with tolerance, fixed-width binary masks (preserving leading zeroes), ordered/unordered/nested lists with positional partial credit, dropdowns/MCQs by stable option ID, and structured short text.
- **Zero embedded exam content** — contains no real OS questions or answers. Load Practice 1, 2, 3, 4, 5+ as paired `.txt` files without touching source code.

---

## Quick Start

### Prerequisites
- **Node.js v22.18+ or v24+** (uses built-in TypeScript execution and `node:sqlite` — zero external runtime dependencies required).

### 1. Start the Local Server

```bash
npm start
# or with live file-watch during development:
npm run dev
```

*(On Windows PowerShell where script execution policies block `npm.ps1`, use `npm.cmd start` or `node --no-warnings server/index.ts`.)*

Open **`http://127.0.0.1:3000/practice`** in your browser.

### 2. Import a Paired Practice Test (`.txt`)

When no papers are loaded, `/practice` displays **`No test imported`**. You can import a paired `PUBLIC questions (.txt)` + `PRIVATE memo (.txt)` in two ways:

- **Web UI:** Open `http://127.0.0.1:3000/import`, select or paste both `.txt` files, and click **Validate & Import**.
- **CLI:**
  ```bash
  node --no-warnings server/cli-import.ts --public path/to/practice1.public.txt --memo path/to/practice1.memo.txt
  ```

See **[IMPORT_GUIDE.md](./IMPORT_GUIDE.md)** for the full `.txt` schema and deterministic grader specification.

### 3. Developer UI Fixture (Artificial Placeholder Only)

To preview the Moodle attempt and review UI using the clearly marked artificial non-OS fixture (`fixtures/artificial-fixture.public.txt` + `fixtures/artificial-fixture.memo.txt`):

```bash
node --no-warnings server/cli-import.ts --fixtures
```

To remove all artificial fixture data without touching any real practice attempts:

```bash
node --no-warnings server/cli-import.ts --clear-fixtures
```
*(Or click **Clear fixture data** on `/practice`.)*

---

## Running Automated Tests

```bash
# Unit & integration tests (graders, schema validation, timer authority, memo secrecy, 5-paper coexistence):
node --no-warnings --test --test-concurrency=1 "tests/unit/*.test.ts"

# End-to-end browser flow test (start -> answer -> navigate -> submit -> review):
node --no-warnings --test --test-concurrency=1 "tests/e2e/*.test.ts"
```
