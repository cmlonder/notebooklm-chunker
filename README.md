# notebooklm-chunker

[![CI](https://github.com/cmlonder/notebooklm-chunker/actions/workflows/ci.yml/badge.svg)](https://github.com/cmlonder/notebooklm-chunker/actions/workflows/ci.yml)
[![Desktop Release](https://github.com/cmlonder/notebooklm-chunker/actions/workflows/desktop-release.yml/badge.svg)](https://github.com/cmlonder/notebooklm-chunker/actions/workflows/desktop-release.yml)
[![PyPI version](https://badge.fury.io/py/notebooklm-chunker.svg)](https://badge.fury.io/py/notebooklm-chunker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Turn long documents into smaller, heading-aware NotebookLM sources so reports, slide decks, quizzes, flashcards, and audio outputs stay more focused and useful.

> **Two interfaces, one core.** The Desktop app provides a visual workflow. The CLI provides scriptable automation. Both use the same `nblm` engine underneath.
>
> - **This page** covers the Desktop app
> - **[CLI.md](CLI.md)** covers the Python CLI

---

## Desktop App

An Electron desktop client that wraps the `nblm` CLI into a full visual workflow — from PDF upload to NotebookLM Studio generation.

### Features NotebookLM Doesn't Have

| Feature | Description |
|---|---|
| **Heading-aware chunking** | Splits documents at heading boundaries (H1, H2, etc.) instead of arbitrary page breaks, keeping each source semantically coherent |
| **Bulk source upload** | Upload dozens or hundreds of chunks to a single notebook in one operation with parallel processing |
| **Bulk source delete** | Select and delete multiple chunks at once from the catalog |
| **Resume interrupted uploads** | Sync tracks per-chunk status — come back tomorrow and only the remaining chunks get uploaded |
| **Studio queue with retry** | Queue reports, slides, quizzes, flashcards, or audio jobs across multiple sources. Failed jobs (including quota exhaustion) are detected and can be retried individually or in bulk |
| **Studio filtering by type** | Tab bar filters queue and generated outputs by studio type (report, slide deck, quiz, flashcards, audio) with search |
| **Prompt library** | Save reusable prompts per studio type and apply them from the queue builder |
| **Per-source settings** | Configure language (80+ languages), format, length, and parallel request limits per studio type |
| **Skip pages** | Exclude preface, table of contents, index, or bibliography pages before chunking |
| **Versioned lineages** | Multiple chunk versions of the same PDF, each with independent sync and studio state |
| **Offline-first** | Chunk and edit locally without a network connection — sync when ready |

### Installation

#### Prerequisites

1. Install the Python CLI (needed by the desktop app):

```bash
pip install notebooklm-chunker
python -m playwright install chromium
```

2. Login to NotebookLM:

```bash
nblm login
```

#### Option A: Download Release Binary

Download the latest release for your platform from [GitHub Releases](https://github.com/cmlonder/notebooklm-chunker/releases):

- **macOS**: `.dmg` or `.zip`
- **Windows**: `.exe` (installer) or portable
- **Linux**: `.AppImage` or `.deb`

The desktop app expects `nblm` to be available on your system PATH.

#### Option B: Run From Source

```bash
cd desktop
npm install
npm run dev
```

### Setup Check

On first launch, the app verifies:

- `nblm` is available on PATH
- Playwright Chromium is installed
- NotebookLM auth state is ready

You can continue into the app for local-only work even if auth is not ready yet.

### Workflow

1. **Document** — Upload a PDF to start a new chunk set
2. **Structure** — Set min/max pages per chunk, skip pages from beginning or end, see estimated chunk count
3. **Sources** — Review, search, edit, and bulk-manage the generated chunks
4. **Sync** — Upload changed chunks to a new or existing NotebookLM notebook
5. **NotebookLM Dashboard** — Browse notebooks, inspect synced sources, queue studio jobs, track outputs

### NotebookLM Settings

Accessible from Settings in the sidebar:

- **Sources tab** — Per studio type: language (80+ languages), format, download format, max parallel requests
- **Sync tab** — Max parallel chunk uploads

Settings persist across sessions and are applied to all future queue items.

### Studio Queue

The queue panel mirrors the Studios panel:

- Filter by studio type via tab bar (All, Report, Slide Deck, Quiz, Flashcards, Audio)
- Search jobs by name, source, status, or message
- Retry failed jobs individually or bulk retry all
- Clear submitted jobs when done
- Remove individual jobs from the queue

Quota exhaustion and zero-output runs are automatically detected as failures, enabling retry after the cooldown period.

### Build

Platform-specific builds:

```bash
cd desktop
npm run build:mac    # macOS (.dmg, .zip)
npm run build:win    # Windows (.exe, portable)
npm run build:linux  # Linux (.AppImage, .deb)
```

### Project Layout

```text
desktop/
├── renderer/
│   ├── app.js           # Main UI logic
│   ├── index.html       # UI structure
│   ├── styles.css        # Styles
│   └── project-utils.js  # Helper utilities
├── src/
│   ├── main.js           # Electron main process
│   └── preload.js        # IPC bridge
└── tests/
    └── project-utils.test.js
```

---

## CLI

The Python CLI is the automation engine. It handles document parsing, heading-aware chunking, NotebookLM uploads, and Studio generation.

For full CLI documentation, installation, config examples, and usage:

**[CLI.md](CLI.md)**

Quick start:

```bash
pip install notebooklm-chunker
python -m playwright install chromium
nblm login
nblm run --config ./nblm.toml
```

---

## Development

For setup, testing, packaging, and GitHub release flow, see [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT
