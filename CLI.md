# notebooklm-chunker CLI

[![PyPI version](https://badge.fury.io/py/notebooklm-chunker.svg)](https://badge.fury.io/py/notebooklm-chunker)
[![Python 3.12+](https://img.shields.io/badge/python-3.12+-blue.svg)](https://www.python.org/downloads/)

The Python CLI is the automation core behind notebooklm-chunker. It handles document parsing, heading-aware chunking, NotebookLM uploads, and Studio generation.

The Desktop app uses this CLI under the hood.

## Requirements

- Python 3.12+
- `pip`

This project automates NotebookLM through
[`notebooklm-py`](https://github.com/teng-lin/notebooklm-py), which is an
unofficial community library.

## Installation

From PyPI:

```bash
pip install notebooklm-chunker
python -m playwright install chromium
nblm login
```

With `pipx`:

```bash
pipx install notebooklm-chunker
python -m playwright install chromium
nblm login
```

From a local checkout:

```bash
python -m pip install /ABS/PATH/notebooklm-chunker
python -m playwright install chromium
nblm login
```

If you already have valid NotebookLM auth state, you can skip `nblm login`.

To clear local `notebooklm-py` auth state later:

```bash
nblm logout
```

## Quick Start

Create a workflow file:

```bash
nblm init
```

Run the whole flow:

```bash
nblm run --config ./nblm.toml
```

Continue later from the saved run state:

```bash
nblm resume --config ./nblm.toml
```

Add new per-chunk Studio outputs later without re-uploading chunks:

```bash
nblm studios --config ./quiz.toml
```

Check auth, config, Playwright, and parser readiness:

```bash
nblm doctor --config ./nblm.toml
```

Show the installed CLI version:

```bash
nblm --version
```

`source.path` lives in the config file, so you do not need to pass the input
document as a CLI argument.

## Repo Demo

This repository includes a full example built around the freely downloadable
InfoQ mini-book
[Domain-Driven Design Quickly](https://www.infoq.com/minibooks/domain-driven-design-quickly/).

```bash
nblm run --config ./examples/workflows/ddd-quickly-demo.toml
```

Generated NotebookLM:

- [DDD Quickly Interactive Learning Kit](https://notebooklm.google.com/notebook/3dec967d-7093-4937-917f-173763f79395)

## Run State And Resume

`nblm run` always starts a fresh run and writes a state file next to the chunk
output:

```text
./output/chunks/.nblm-run-state.json
```

That file tracks:

- source upload status for each chunk
- Studio status for each chunk
- saved `source_id`, `task_id`, `artifact_id`, output path, and last error when available

This is why `nblm resume` can continue later without redoing finished work.

Source uploads and per-chunk Studio jobs run as separate queues.

Quota blocks are tracked per Studio type. If `report` is blocked, `slide_deck`
or `quiz` can still continue until they hit their own limits.

## Add More Studios Later

If a previous `run` already uploaded the chunk sources, `nblm studios` can
reuse `.nblm-run-state.json` and add new per-chunk Studio outputs later
without uploading the chunks again.

Example:

```bash
nblm studios --config ./quiz.toml
```

For `per_chunk = true`, this stays scoped to the saved per-chunk source IDs
from the same run state.

## Output Files

One `chunking.output_dir` represents one workflow lineage.

That lineage owns:

- chunk markdown files
- `manifest.json`
- `.nblm-run-state.json`

If you want another book, or the same book as a separate NotebookLM run, use a
different `chunking.output_dir`.

## Example Config

```toml
[source]
path = "./book.pdf"

[notebook]
title = "Book Notes"

[chunking]
output_dir = "./output/{source_stem}/chunks"
target_pages = 3.0
min_pages = 2.5
max_pages = 4.0

[runtime]
max_parallel_chunks = 3

[studios.report]
enabled = true
per_chunk = true
output_dir = "./output/{source_stem}/reports"
language = "en"
format = "study-guide"
```

## Workflow Notes

- paths inside workflow files are resolved relative to that file
- output paths may use `{source_stem}`
- `runtime.download_outputs = false` is supported
- one `chunking.output_dir` maps to one NotebookLM workflow lineage

## Development

For setup, testing, packaging, and GitHub release flow, see
[DEVELOPMENT.md](DEVELOPMENT.md).
