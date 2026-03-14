# Development Guide

This repository is meant to be easy to run locally and easy to contribute to as
an open-source project.

## Requirements

- Python 3.12+
- `git`
- `pip`
- `python -m playwright install chromium` only if you want to test `nblm login`
  or live NotebookLM flows

## Local Setup

Create a virtual environment and install the project in editable mode:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
python -m playwright install chromium
```

Windows PowerShell activation:

```powershell
.venv\Scripts\Activate.ps1
```

If you are only working on parsers or chunking logic, Playwright is not
required.

## Day-to-Day Commands

Show the CLI:

```bash
nblm --help
```

Show the installed CLI version:

```bash
nblm --version
```

If `prepare` or a fresh `run` targets a non-empty chunk output folder, `nblm`
asks before overwriting the chunk files and run state there. Use `--yes` when
you want to skip that confirmation.

Run the built-in health check:

```bash
nblm doctor --config ./nblm.toml
```

Run the unit test suite:

```bash
python -m unittest discover -s tests -v
```

Run the desktop helper tests:

```bash
cd desktop
npm test
```

Run the full local release-prep checklist:

```bash
bash scripts/release_prep.sh
```

Run a local desktop build for your current platform:

```bash
bash scripts/release_desktop_local.sh
```

Run a local Markdown chunking smoke test:

```bash
nblm prepare --config ./examples/workflows/markdown.toml
```

Run a local PDF chunking smoke test:

```bash
nblm prepare --config ./examples/workflows/pdf.toml
```

Run a full live NotebookLM flow with one Studio output:

```bash
nblm login
nblm run --config ./examples/workflows/studios/audio.toml
```

Resume an unfinished run later:

```bash
nblm resume --config ./examples/workflows/studios/audio.toml
```

Clear local notebooklm-py auth state when you want a fresh session:

```bash
nblm logout
```

Run the full multi-Studio demo:

```bash
nblm run --config ./examples/workflows/learning-kit.toml
```

If you already have a notebook and only want to rerun Studio generation:

```bash
nblm studios --config ./examples/workflows/studios/report.toml --notebook-id <notebook_id>
```

If a previous run already uploaded chunk sources, `nblm studios` can also reuse
`.nblm-run-state.json` to run new per-chunk Studio jobs later without
re-uploading the chunks:

```bash
nblm studios --config ./examples/workflows/studios/quiz.toml
```

## Workflow Notes

- Full workflow examples live under `examples/workflows/`.
- Single-Studio workflow examples live under `examples/workflows/studios/`.
- Paths inside workflow files are resolved relative to that file.
- Config paths may use `{source_stem}`. Example: if `source.path` is
  `./docs/book.pdf`, then `./output/{source_stem}/chunks` becomes
  `./output/book/chunks`.
- `runtime.download_outputs = false` keeps Studio completion in the run state
  without downloading local artifact files.
- Start with `runtime.max_parallel_chunks = 3` for live NotebookLM runs; values like `5` can hit quota faster.
- Use `studios.slide_deck.max_parallel = 4` if you want slide decks to run four at a time while keeping the generic heavy-Studio fallback lower for everything else.
- Generated example outputs go under `examples/workflows/output/` and are gitignored.
- `nblm run` uses the uploaded chunk source IDs for Studio generation, so it
  does not accidentally widen the context to unrelated sources already in the
  same notebook.
- `nblm run` starts fresh; `nblm resume` is the explicit continuation path for `.nblm-run-state.json`.
- Saved quota blocks are Studio-specific. If `report` is blocked, other Studio
  types may still keep moving until they hit their own limits.

## Editable Install Notes

Because the package is installed with `-e`, code changes are picked up
immediately. You do not need to reinstall after every edit.

If you change dependency metadata in `pyproject.toml`, reinstall once:

```bash
python -m pip install -e ".[dev]"
```

## Packaging Check

Before tagging a release, build the package locally:

```bash
python -m build
```

Validate the built metadata too:

```bash
python -m twine check dist/*
```

## Release Flow

The repo is set up for GitHub Actions based release automation:

- `.github/workflows/ci.yml` runs tests, builds the package, and checks the built metadata on pushes and pull requests
- `.github/workflows/publish.yml` builds and publishes to PyPI when a GitHub release is published or when the workflow is run manually

PyPI publishing expects Trusted Publishing to be configured for this repository.
In PyPI, add this GitHub repository as a trusted publisher for the `notebooklm-chunker`
project before using the publish workflow.

Typical release flow:

```bash
bash scripts/release_prep.sh
git push origin main
git tag -a v0.2.1 -m "Release v0.2.1"
git push origin v0.2.1
```

Then:

1. Open GitHub Releases
2. Draft or publish a release for that tag
3. Publishing the release triggers `.github/workflows/publish.yml`
4. That workflow rebuilds the package and uploads it to PyPI

Recommended release order:

1. update version in `pyproject.toml`
2. update version in `notebooklm_chunker/__init__.py`
3. run `bash scripts/release_prep.sh`
4. push `main`
5. create and push tag
6. publish GitHub release
7. verify the PyPI install in a fresh virtual environment

If you want to prepare the release locally but not tag yet, stop after
`bash scripts/release_prep.sh`.

## Desktop Binary Release Flow

Desktop binaries are released through a separate GitHub Actions workflow:

- `.github/workflows/desktop-release.yml`

That workflow:

- runs on GitHub release publish
- builds desktop artifacts on:
  - macOS
  - Windows
  - Linux
- uploads those artifacts to the GitHub release page

Typical desktop release flow:

```bash
bash scripts/release_desktop_local.sh
git push origin main
git tag -a v0.2.1 -m "Release v0.2.1"
git push origin v0.2.1
```

Then publish the GitHub release for that tag. Two workflows will run:

- `.github/workflows/publish.yml` for the Python package / PyPI
- `.github/workflows/desktop-release.yml` for Electron desktop binaries

Important current limitation:

- the desktop app still shells out to `nblm`
- that means the released Electron binary is not yet fully self-contained
- end users still need `notebooklm-chunker` installed and available on `PATH`
- `python -m playwright install chromium` and `nblm login` are still part of the live NotebookLM setup path

So today the desktop binary release is a packaged UI shell around the CLI, not
an all-in-one installer.

## Local Package Verification

Before publishing, do one clean install test in a fresh virtual environment so
you can verify the binary that would be installed from your current checkout,
not the editable install in your repo shell:

```bash
python -m venv /tmp/nblm-test
source /tmp/nblm-test/bin/activate
python -m pip install --upgrade pip
python -m pip install --force-reinstall /ABS/PATH/notebooklm-chunker
which nblm
nblm --version
nblm --help
deactivate
```

This installs from your local checkout. It is the right check when you have
new code that has not been published to PyPI yet.

## Release Verification

After the PyPI publish succeeds, do one more clean install test in a fresh
virtual environment so you are not accidentally relying on your local checkout
or your editable install:

```bash
python -m venv /tmp/nblm-test
source /tmp/nblm-test/bin/activate
python -m pip install --upgrade pip
python -m pip install notebooklm-chunker
which nblm
nblm --version
nblm --help
deactivate
```

This installs from PyPI. If this test still shows old behavior, the new release
did not make it to the index you are testing against yet.

## Desktop App Notes

The desktop client lives under `desktop/`.

Local desktop commands:

```bash
cd desktop
npm install
npm run dev
```

The desktop app is currently a repo-based workflow, not a separately published
binary release process. GitHub releases today are used for the Python package
release flow above.

## Project Layout

Important paths:

- `notebooklm_chunker/cli.py`: CLI entrypoint
- `notebooklm_chunker/config.py`: workflow config loading and validation
- `notebooklm_chunker/parsers.py`: file parsing layer
- `notebooklm_chunker/chunker.py`: heading-aware chunking logic
- `notebooklm_chunker/uploaders/notebooklm_py.py`: NotebookLM upload and Studio integration
- `examples/workflows/`: runnable sample workflow files
- `tests/`: unit test suite
- `desktop/`: Electron desktop client

## Contribution Expectations

- Keep the config-driven workflow simple for end users.
- Prefer changes that preserve the parser/chunker core as reusable code.
- Add or update tests when behavior changes.
- Keep `README.md`, this file, and the sample workflow files in sync.
