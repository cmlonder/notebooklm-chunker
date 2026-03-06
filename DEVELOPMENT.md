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

Run the built-in health check:

```bash
nblm doctor --config ./nblm.toml
```

Run the unit test suite:

```bash
python -m unittest discover -s tests -v
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

## Workflow Notes

- Full workflow examples live under `examples/workflows/`.
- Single-Studio workflow examples live under `examples/workflows/studios/`.
- Paths inside workflow files are resolved relative to that file.
- Generated example outputs go under `examples/workflows/output/` and are gitignored.
- `nblm run` uses the uploaded chunk source IDs for Studio generation, so it
  does not accidentally widen the context to unrelated sources already in the
  same notebook.

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

## Project Layout

Important paths:

- `notebooklm_chunker/cli.py`: CLI entrypoint
- `notebooklm_chunker/config.py`: workflow config loading and validation
- `notebooklm_chunker/parsers.py`: file parsing layer
- `notebooklm_chunker/chunker.py`: heading-aware chunking logic
- `notebooklm_chunker/uploaders/notebooklm_py.py`: NotebookLM upload and Studio integration
- `examples/workflows/`: runnable sample workflow files
- `tests/`: unit test suite

## Contribution Expectations

- Keep the config-driven workflow simple for end users.
- Prefer changes that preserve the parser/chunker core as reusable code.
- Add or update tests when behavior changes.
- Keep `README.md`, this file, and the sample workflow files in sync.
