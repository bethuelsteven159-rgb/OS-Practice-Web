# Paired TXT Import Guide (Public Questions + Private Memo)

This guide defines the exact file contract for loading new practice papers (Practice 1, Practice 2, Practice 3, Practice 4, Practice 5, and beyond) into the exam simulator without editing any application source code.

> **Security & Privacy Rule:**
> Never commit any `*.memo.txt` file containing real practice solutions to a public repository. The `.gitignore` in this project automatically ignores `*.memo.txt` (outside `fixtures/`) and `inbox/`. Private memos are stored only inside the local server-side SQLite database (`data/app.db`) and are never transmitted to the browser while an attempt is in progress.

---

## 1. File Naming Convention

For each practice paper `N` (`1`, `2`, `3`, `4`, `5`, ...), provide two UTF-8 `.txt` files:

1. **`practiceN.public.txt`** — Public exam metadata, question stems, subpart prompts, input types, syntax hints, and dropdown/MCQ choice labels. **Must not** contain answers, solutions, or grading rules.
2. **`practiceN.memo.txt`** — Private answer memo keyed by the exact `testId`, `version`, `question_id`, and `part_id` values from the public file. Contains deterministic grader definitions, tolerances, per-part feedback, and worked solutions.

---

## 2. Format A: UTF-8 JSON inside `.txt` (Recommended)

Even though the filenames end in `.txt`, the recommended content format is standard UTF-8 JSON.

### 2.1 Public Questions File (`practiceN.public.txt`)

```json
{
  "schemaVersion": "1.0",
  "kind": "public_questions",
  "testId": "practice-1",
  "version": 1,
  "title": "Practice Test 1",
  "courseName": "COMS3010A-OS-SM2-2026",
  "sectionName": "Test 1 & Test 2",
  "durationSeconds": 7200,
  "totalMarks": 6,
  "questions": [
    {
      "id": "q1",
      "number": 1,
      "marks": 6,
      "stem": [
        "Paragraph of stem text supporting **bold**, *italics*, `inline_code`, and \\(123\\) math.",
        {
          "type": "code",
          "boxed": true,
          "text": "line 1 of boxed code\nline 2 of boxed code"
        },
        {
          "type": "table",
          "header": ["Col A", "Col B"],
          "rows": [
            ["`0x00`", "**100**"]
          ]
        }
      ],
      "parts": [
        {
          "id": "a",
          "label": "(a)",
          "type": "integer",
          "marks": 2,
          "prompt": "Subpart (a) question prompt?",
          "answerInputHint": "(a whole number - do not type the unit)",
          "inputWidth": 11
        },
        {
          "id": "b",
          "label": "(b)",
          "type": "list",
          "marks": 2,
          "prompt": "Subpart (b) list prompt?",
          "answerInputHint": "(a list of four numbers in square brackets)",
          "inputWidth": 22
        },
        {
          "id": "c",
          "label": "(c)",
          "type": "dropdown",
          "marks": 2,
          "prompt": "Subpart (c) dropdown prompt?",
          "choices": [
            { "id": "c1", "label": "First option text" },
            { "id": "c2", "label": "Second option text" },
            { "id": "c3", "label": "Third option text" }
          ]
        }
      ]
    }
  ]
}
```

### 2.2 Private Memo File (`practiceN.memo.txt`)

```json
{
  "schemaVersion": "1.0",
  "kind": "private_memo",
  "testId": "practice-1",
  "version": 1,
  "totalMarks": 6,
  "questions": {
    "q1": {
      "solution": [
        "Detailed worked derivation and pedagogical explanation paragraphs shown in the pale-orange review panel after submission.",
        {
          "type": "ul",
          "items": [
            "**Point 1** explanation.",
            "**Point 2** explanation."
          ]
        }
      ],
      "parts": {
        "a": {
          "marks": 2,
          "grader": { "type": "integer", "answer": 42 },
          "feedback": ["Optional short diagnostic shown right under the subpart verdict."]
        },
        "b": {
          "marks": 2,
          "grader": {
            "type": "list",
            "answer": [1, 2, 3, 4],
            "items": "integer",
            "ordered": true,
            "partial": "positional"
          }
        },
        "c": {
          "marks": 2,
          "grader": { "type": "choice", "answer": "c2" }
        }
      }
    }
  }
}
```

---

## 3. Supported Part Types & Deterministic Graders

| Public `part.type` | Private `grader.type` | Accepted Format & Deterministic Marking Rules |
| :--- | :--- | :--- |
| `integer` | `integer` | `{ "type": "integer", "answer": 112, "accept": [112] }` — Trims whitespace, parses exact integer (`BigInt`), rejects decimals or units. |
| `decimal` | `decimal` | `{ "type": "decimal", "answer": 2.5, "absTol": 0.01, "relTol": 0 }` — Compares numerically within tolerance; also accepts exact numeric ratios such as `5/2`. |
| `binary` | `binary` | `{ "type": "binary", "answer": "00001011010110", "width": 14 }` — Requires only `0`/`1` and enforces exact bit width (preserving leading zeroes). |
| `list` / `ordered_list` | `list` | `{ "type": "list", "answer": [0, 1, 2, 4], "items": "integer", "ordered": true, "partial": "none" \| "positional" }` — Parses `[a, b, c]` (including nested `[[addr, len], ...]` pairs), checks element count first (emitting `Your list should have N elements, but it actually has M.`), and supports exact or positional partial credit. |
| `dropdown` / `radio` | `choice` | `{ "type": "choice", "answer": "c2" }` — Compares against stable `choice.id` (never option order). |
| `checkbox` | `multichoice` | `{ "type": "multichoice", "answers": ["c1", "c3"], "partial": "none" \| "proportional" }` — Compares selected option IDs. |
| `text` | `text` | `{ "type": "text", "accept": ["variant 1", "variant 2"], "caseSensitive": false, "regex": ["^optional_pattern$"] }` — Normalizes whitespace and checks accepted strings/regexes. |

---

## 4. How to Import, Validate, Preview & Start

### Option 1 — CLI Import (Offline Command)

```bash
npm run import -- --public path/to/practice1.public.txt --memo path/to/practice1.memo.txt
```

- You can also import the public file first to preview metadata in the library:
  ```bash
  npm run import -- --public path/to/practice1.public.txt
  ```
  *(The app will block starting a graded attempt until you also run `npm run import -- --memo path/to/practice1.memo.txt`.)*

### Option 2 — Local Web Import Screen

1. Start the server (`npm run dev` or `npm start`) and open `http://127.0.0.1:3000/import`.
2. Upload or paste the **Public Questions (`.txt`)** file and **Private Memo (`.txt`)** file.
3. Click **Validate & Import**. Any ID mismatch, mark-sum mismatch, or invalid grader fails loudly with a detailed validation report.
4. Once validated, click **Return to Practice Quizzes** (`/practice`), open the imported test, and click **Attempt quiz now** to begin the 2-hour timed sitting in one-question-per-page mode.
