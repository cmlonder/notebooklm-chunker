# NotebookLM Chunker Desktop

Electron desktop client for the `nblm` workflow.

It is designed around one local project lineage per chunk output directory:

- pick a PDF
- create or resume a versioned local project
- tune the chunk count with a slider
- refine chunk titles and content inline
- sync changed chunks to NotebookLM
- generate more Studio outputs later from the saved `.nblm-run-state.json`

## Prerequisites

- Node.js 18+
- `nblm` available on your `PATH`
- a working NotebookLM login if you want live sync or Studio generation

The desktop app shells out to the real CLI. It does not reimplement the core
workflow.

The renderer now ships with local styles and icon fallbacks, so it does not
depend on Tailwind or Google Fonts CDNs at runtime.

## Development

```bash
cd desktop
npm install
npm run dev
```

## Tests

Run the desktop unit tests:

```bash
cd desktop
npm test
```

These tests cover the pure helper logic used by the UI:

- project/version naming
- project status derivation
- Studio workflow TOML generation
- notebook ID parsing from CLI output

## Build

```bash
cd desktop
npm run build
```

Platform-specific builds:

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

## Main Features

- Recent project dashboard with sync and quota status
- PDF persistence and versioned local project folders
- Chunk count slider before prepare
- Inline title/content editing with autosave
- Read-only behavior once a fully synced lineage is resumed
- Bulk chunk selection and delete
- Existing NotebookLM selection or new notebook creation
- Later Studio generation from the saved run state

## Project Layout

```text
desktop/
├── renderer/
│   ├── app.js
│   ├── index.html
│   └── project-utils.js
├── src/
│   ├── main.js
│   └── preload.js
└── tests/
    └── project-utils.test.js
```
