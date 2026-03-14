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

On first launch, the app shows a setup screen and checks:

- `nblm` availability on `PATH`
- Playwright Chromium readiness
- NotebookLM auth readiness

If live NotebookLM auth is not ready yet, you can still continue into the app
for local-only work and come back to sign in later.

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

For a local release-style build on your current platform:

```bash
bash ../scripts/release_desktop_local.sh
```

## GitHub Release Binaries

GitHub releases can now attach desktop artifacts automatically through:

- `.github/workflows/desktop-release.yml`

When a GitHub release is published, the workflow builds and uploads:

- macOS: `dmg`, `zip`
- Windows: `nsis`, `portable`
- Linux: `AppImage`, `deb`

Important:

- the desktop app still expects `nblm` on `PATH`
- it does not bundle the Python CLI/runtime yet
- so these binaries are packaged desktop shells around the existing CLI workflow

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
