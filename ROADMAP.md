# notebooklm-chunker — Product & Engineering Roadmap

This is the single source of truth for where the project is going. It spans
chunk quality, Studio/queue reliability, desktop UX, product expansion,
packaging/distribution, and the OSS/CI baseline.

**Status legend:** ✅ shipped · 🚧 in progress · ⬜ planned

---

## 0. Recently shipped (foundation)

The refactor + reliability pass that made everything below feasible:

- ✅ notebooklm-py 0.7 compatibility (quiz/flashcards crash, mind_map result,
  per-profile auth detection, logout on new layout)
- ✅ Uploader is table-driven (`StudioSpec`); all nine Studio types run through
  one tested code path
- ✅ TOC-aware chunking: heading text + hierarchy levels from the PDF outline,
  level-weighted boundary planning, running-header filtering
- ✅ New Studio options: video `cinematic`/`custom` + `style_prompt`,
  infographic styles, `sources.add_file(title=)`
- ✅ Desktop hardening: `escapeHtml` everywhere, `internal-write-file` split
  into its own IPC handler, dedup of search/tab/filter/row code
- ✅ Desktop modularization: `app.js` split into ES modules by view
- ✅ Multi-account profiles: `--profile` across the CLI, `login --account` /
  `--all-accounts`, `nblm profile`, `nblm list-profiles`, desktop account
  switcher, `doctor` reports the active account
- ✅ Experimental PyInstaller sidecar so the desktop app runs without a system
  Python install; Playwright browser-path fix for the frozen binary
- ✅ OSS baseline: ruff, mypy, coverage (79%+), split CI jobs, pip-audit,
  trivy, CodeQL, Dependabot, repo hygiene files

---

## Phase A — Chunk quality & the core loop (P0)

The reason the tool exists: split a long book at logical (heading) boundaries so
each per-chunk Studio output stays focused. Everything here sharpens that edge.

- ⬜ **A1. Section-tree preview in the Structure tab.** Render the heading
  hierarchy (from TOC/heuristics) as a collapsible tree before chunking: which
  chunk covers which sections, page ranges, estimated size. *Files:* new
  `nblm inspect --tree --json` output; desktop Structure view. *Why:* users must
  see the split before committing.
- ⬜ **A2. Manual boundary editing.** On the tree, add/remove/move split points;
  drop a mis-detected heading, add a missed one. Persist overrides in the
  manifest so re-runs respect them. *Why:* heuristics are never 100%; final say
  is the differentiator.
- ⬜ **A3. Font-size heading detection.** For TOC-less PDFs, use
  `get_text("dict")` to treat "significantly larger than body font" as a heading
  signal, combined with the existing heuristics. *Files:* `parsers.py`.
- ⬜ **A4. Chunk quality report.** Flag over-short/over-long chunks, duplicate
  headings, heading-less chunks, and mid-section cuts. Surface as a
  "N chunks need review" list. *Files:* new `chunker` analysis fn + `nblm
  inspect`; desktop Sources view banner.
- ⬜ **A5. Front-matter auto-detection.** When a TOC exists, propose
  preface/TOC/index/bibliography page ranges to skip automatically. *Files:*
  `parsers.py`, Structure view.
- ⬜ **A6. Skip-page ranges in desktop.** CLI supports `skip_ranges`; desktop
  only does leading/trailing N. Expose mid-document range skipping in the UI.
- ⬜ **A7. Chunk context continuity (opt-in).** Prepend a book/chapter breadcrumb
  and the previous chunk's tail so Studio outputs know their context. *Files:*
  `exporters.py`, config flag.
- ⬜ **A8. Re-chunk diff.** When min/max changes, diff old vs new boundaries; if
  chunks are already synced, warn which NotebookLM sources need updating.

## Phase B — Studio & queue experience (P1)

- ⬜ **B1. Quota countdown + auto-resume.** `blocked_until` is known; show a live
  countdown and auto-continue the queue when the block expires. *Files:*
  `desktop/src/main.js` queue worker, studio view.
- ⬜ **B2. Structured JSON progress protocol.** Add `nblm ... --json-progress`
  emitting line-delimited JSON events; desktop drives progress bars off real
  data instead of substring-matching stdout. *Files:* `cli.py`, uploader
  reporter, `main.js`, `sync.js`/`studio.js`.
- ⬜ **B3. Bulk queue progress + ETA.** Aggregate "42% · ~1h20m left" across
  hundreds of jobs. *Files:* studio view.
- ⬜ **B4. Native OS notifications.** Notify on batch complete / quota cleared /
  failure. *Files:* `main.js` (Electron `Notification`).
- ⬜ **B5. Artifact previewer.** Render generated report/quiz/flashcards inside
  the app (markdown render, quiz question list) instead of file-only download.
- ⬜ **B6. Quiz player.** Solve generated quizzes interactively in-app
  (answer → correct/wrong). Turns the tool from generator into study experience.
- ⬜ **B7. Anki `.apkg` export.** Convert flashcard JSON to an Anki deck. *Files:*
  new exporter module.
- ⬜ **B8. Artifact bundling.** Export all outputs for a book (reports + quizzes
  + audio) as one zip/folder tree.
- ⬜ **B9. Log panel.** Filterable, copyable, leveled log view replacing the raw
  red error box on job cards.
- ⬜ **B10. Fetch-later.** Download previously completed remote artifacts when
  `download_outputs = false`.

## Phase C — Desktop UX & polish (P1)

- ⬜ **C1. Setup wizard.** Step-by-step first-run: auth → "Login" button,
  Playwright missing → guided fix, sidecar detection. Replaces the passive
  checklist.
- ⬜ **C2. Settings ↔ engine sync.** Remove stale quiz `More`; add video
  `cinematic`/`custom`+`style_prompt`, infographic styles, and mind_map +
  data_table settings panels (absent today). *Files:* `settings.js`,
  `config.py` templates.
- ⬜ **C3. Dark mode.** Theme toggle, persisted, full token coverage. *Files:*
  `styles.css`, `index.html`, theme persistence.
- ⬜ **C4. Turkish UI + locale.** i18n scaffolding, language switch; verify
  comma-decimal input maps correctly to TOML.
- ⬜ **C5. Virtualized lists.** Catalog with 128+ chunks renders everything to
  the DOM; virtualize for hundreds of rows.
- ⬜ **C6. Keyboard shortcuts + command palette.** Cmd+K palette; select chunk →
  Q to queue a quiz, etc.
- ⬜ **C7. Bulk title cleanup.** "Strip numbering from all titles", "fix
  capitalization" batch actions in the catalog.

## Phase D — Product expansion (P2)

- ⬜ **D1. Workflow presets.** One-click "Learning Kit", "Quiz Only", "Podcast
  Series" config bundles in the New Chunk flow.
- ⬜ **D2. Prompt template variables.** `{chapter_title}`, `{book_title}`,
  `{chunk_index}` in saved prompts.
- ⬜ **D3. Multi-document → one notebook.** Upload several PDFs as lineages into
  one notebook for comparative Studio generation.
- ⬜ **D4. Book-level aggregate artifact.** After a per-chunk pass, generate one
  "final exam" quiz or "book summary" report from all chunk sources.
- ⬜ **D5. URL / EPUB / Markdown-dir inputs in desktop.** Parser already supports
  these; expose a source-type picker.
- ⬜ **D6. OCR fallback** for scanned PDFs (OCRmyPDF/tesseract) with a
  "no text found — run OCR?" flow.
- ⬜ **D7. Source freshness.** Detect "local chunk changed, NotebookLM source
  stale" and offer one-click refresh via notebooklm-py freshness APIs.

## Phase E — Platform, packaging, distribution (P2)

- ⬜ **E1. Sidecar in release CI.** Add the PyInstaller build to
  `desktop-release.yml` so installers on all three platforms bundle `nblm` — the
  "no pip needed" promise, shipped.
- ⬜ **E2. Auto-update.** electron-updater in-app updates + CLI↔desktop version
  handshake.
- ⬜ **E3. Windows/Linux QA pass.** PATH resolution, sidecar, file paths are
  effectively macOS-tested today.

## Phase F — notebooklm-py 0.8 & future (P3)

- ⬜ **F1. REST sidecar mode.** When 0.8 stabilizes, run notebooklm-py's REST
  server as a persistent sidecar; desktop talks HTTP with real progress
  callbacks instead of spawning CLI processes.
- ⬜ **F2. Master-token headless auth** to simplify the login UX.
- ⬜ **F3. Source labels** to tag lineages on the NotebookLM side.
- ⬜ **F4. Evaluation harness** for prompt/chunk quality (goldens for boundaries
  and naming).

---

## Execution strategy

Work proceeds in **waves of parallel agents partitioned by file ownership** so
independent tasks never touch the same files in the same wave. After each wave:
integrate → run the full Python suite + desktop tests + ruff → commit per
logical unit. No release/version bumps happen as part of roadmap work.

---

## Appendix — OSS/CI/Security baseline (✅ shipped)

- ✅ ruff (lint + format), mypy, coverage ≥79% enforced in CI
- ✅ CI split into lint / typecheck / test / build; Python 3.12 + 3.13
- ✅ Install verification (wheel → fresh venv → `nblm --version`/`--help`)
- ✅ pip-audit, trivy fs, CodeQL, Dependabot (pip + Actions)
- ✅ CONTRIBUTING, SECURITY, CHANGELOG, issue/PR templates, README badges
- ✅ PyPI trusted publishing; desktop release workflow (per-platform artifacts)

### Release gates (unchanged)

`ruff check` · `ruff format --check` · `mypy` · coverage threshold · full
unittest suite · `python -m build` · `twine check` · fresh-install verification.
