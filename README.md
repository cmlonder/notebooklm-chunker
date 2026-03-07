# notebooklm-chunker

Uploading one large PDF to NotebookLM usually gives weak Studio outputs.
Reports, slide decks, quizzes, and similar artifacts stay short and generic
because they are generated from one oversized context.

`notebooklm-chunker` solves that by splitting a long document into smaller,
heading-aware chunks, uploading each chunk as a separate NotebookLM source,
and then running the Studio outputs you choose. The result is closer to an
interactive learning kit than a single uploaded PDF.

## Demo

This repository ships with a full demo built around the freely downloadable
InfoQ mini-book
[Domain-Driven Design Quickly](https://www.infoq.com/minibooks/domain-driven-design-quickly/).

Demo command:

```bash
nblm run --config ./examples/workflows/ddd-quickly-demo.toml
```

Demo files:

- Workflow file: `./examples/workflows/ddd-quickly-demo.toml`
- Source PDF: `./examples/ddd-quickly.pdf`

What you get:
- NotebookLM is ready with your chunked PDF sources and configured Studio (report and slide in this case) outputs
- Markdown chunks under `./examples/workflows/output/ddd-quickly/chunks`
- One report per chunk under `./examples/workflows/output/ddd-quickly/reports`
- One slide deck per chunk under `./examples/workflows/output/ddd-quickly/slides`

## Requirements

- Python 3.12+
- `pip`
- A NotebookLM account
- The same Python interpreter for install and Playwright setup

This project automates NotebookLM through
[`notebooklm-py`](https://github.com/teng-lin/notebooklm-py), which is an
unofficial community library.

For local development and contribution flow, see `DEVELOPMENT.md`.

## Installation

```bash
pip install "notebooklm-chunker[full]"
python -m playwright install chromium
nblm doctor
nblm login
```

To clear local `notebooklm-py` auth state later:

```bash
nblm logout
```

## Quick Start

Create a starter workflow:

```bash
nblm init
```

Check auth, config, Playwright, and PDF parser readiness:

```bash
nblm doctor --config ./nblm.toml
```

Run the whole flow:

```bash
nblm run --config ./nblm.toml
```

Continue later from the saved run state:

```bash
nblm resume --config ./nblm.toml
```

`source.path` lives in the config file, so you do not need to pass the input
document as a CLI argument.

## Run State And Resume

`nblm run` always starts a fresh run and writes a state file next to the chunk
output:

```text
./output/chunks/.nblm-run-state.json
```

That file tracks every chunk separately:

- whether its NotebookLM source upload is still pending, uploaded, or failed
- whether each Studio job for that chunk is pending, completed, or failed
- the `source_id`, `task_id`, `artifact_id`, output path, and last error when available

Example shape:

```json
{
  "chunks": {
    "001-intro.md": {
      "source": {
        "status": "uploaded",
        "source_id": "src-001-intro"
      },
      "studios": {
        "report": {
          "status": "completed",
          "artifact_id": "art-report-1"
        },
        "slide_deck": {
          "status": "pending",
          "task_id": "art-slide-deck-1"
        }
      }
    }
  }
}
```

This is why `nblm resume` can continue hours or days later after quotas reset:
it does not guess what happened, it reads the saved job state and continues
only the unfinished source or Studio jobs.

If you want to inspect progress manually, open `.nblm-run-state.json`.

Source uploads and per-chunk Studio jobs run as separate queues. That means
new source uploads can keep moving while earlier reports, slide decks, or
other Studio jobs are still running.

### Resume After Quotas

NotebookLM usage limits and quotas depend on your plan. Google documents those
limits here:

- [NotebookLM usage limits and upgrades](https://support.google.com/notebooklm/answer/16213268?hl=en)

That matters for long books. If your quota fills up in the middle of a run,
you can stop, wait for the quota window to reset, and then run:

```bash
nblm resume --config ./nblm.toml
```

Because `nblm` persists source and Studio job state separately, it can continue
from where it left off instead of redoing the whole notebook. NotebookLM's help
page also notes that daily quotas reset after 24 hours.

## Workflow File

This is the practical full workflow shape:

```toml
[source]
path = "./your-document.pdf"
# PDF only. Inclusive page ranges to skip.
# skip_ranges = ["1-8", "399-420", "512"]

[notebook]
title = "Interactive Learning Notebook"
# id = "nb_..."

[chunking]
output_dir = "./output/chunks"
target_pages = 3.0
min_pages = 2.5
max_pages = 4.0
words_per_page = 500

[runtime]
max_parallel_chunks = 3
max_parallel_heavy_studios = 1
studio_wait_timeout_seconds = 7200
studio_create_retries = 5
studio_create_backoff_seconds = 5.0
studio_rate_limit_cooldown_seconds = 30.0
rename_remote_titles = false

[studios.report]
enabled = true
per_chunk = true
max_parallel = 3
output_dir = "./output/reports"
language = "en"
format = "study-guide"
prompt = """
Write a study-guide style report for this chunk.
Explain the main ideas, terminology, and design tradeoffs.
"""

[studios.slide_deck]
enabled = true
per_chunk = true
max_parallel = 3
output_dir = "./output/slides"
language = "en"
format = "detailed"
length = "default"
download_format = "pdf"
prompt = """
Build a teaching deck for this chunk.
Keep the section order and make each slide carry one clear idea.
"""
```

## Studio Parameters

Common fields:

| Field | Meaning |
| --- | --- |
| `enabled` | Turn the Studio on or off. |
| `per_chunk` | Generate one output per chunk instead of one output for the whole notebook. |
| `max_parallel` | Override generic concurrency for this Studio type. |
| `prompt` | Extra instructions for NotebookLM. Use TOML multiline strings for anything non-trivial. |
| `output_path` | Single output file. Best for notebook-level generation. |
| `output_dir` | Output directory for `per_chunk = true`. |
| `language` | Output language when supported. |

Per-Studio options:

| Studio | Extra fields | Defaults |
| --- | --- | --- |
| `audio` | `format`, `length` | `deep-dive`, `long` |
| `video` | `format`, `style` | `explainer`, `whiteboard` |
| `report` | `format` | `study-guide` |
| `slide_deck` | `format`, `length`, `download_format` | `detailed`, `default`, `pdf` |
| `quiz` | `quantity`, `difficulty`, `download_format` | `more`, `hard`, `json` |
| `flashcards` | `quantity`, `difficulty`, `download_format` | `more`, `hard`, `markdown` |
| `infographic` | `orientation`, `detail` | `portrait`, `detailed` |
| `data_table` | `language`, `prompt` | `en`, built-in comparison prompt |
| `mind_map` | `output_path` | JSON output path |

Notes:

- For `report`, `format = "custom"` sends `prompt` as the main custom report prompt.
- For built-in report formats, `prompt` is appended as extra instructions.
- `mind_map` currently has no custom prompt surface in `notebooklm-py`.

## Technical Notes

### Heading-Aware Chunking

- chunks start and end on heading boundaries when possible
- chunk size targets `target_pages` while trying to stay inside `min_pages` and `max_pages`
- local chunk filenames come from the first or nearest heading, including leading numbers

### PDF Cleanup

- `skip_ranges` lets you remove contents, foreword, references, appendix, or index pages
- ranges are inclusive, for example: `["1-8", "399-420", "512"]`

### Parallelism And Quotas

- `max_parallel_chunks` controls how many source uploads run at once
- per-chunk Studio jobs run on their own queues after each source upload finishes
- `max_parallel_heavy_studios` is the generic fallback for heavier Studio types such as `audio`, `video`, `slide_deck`, and `infographic`
- `studios.<name>.max_parallel` overrides that fallback per Studio type
- good starting point for long books: `max_parallel_chunks = 3`
- values like `5` can hit NotebookLM quota or rate-limit errors faster

### Retry And Backoff

- failed NotebookLM `CREATE_ARTIFACT` calls retry automatically
- quota or rate-limit errors trigger a shared cooldown before more Studio create requests are sent
- tune this with:
  - `runtime.studio_create_retries`
  - `runtime.studio_create_backoff_seconds`
  - `runtime.studio_rate_limit_cooldown_seconds`

### Optional NotebookLM Renaming

- by default, NotebookLM keeps its own auto-generated source and artifact titles
- set `runtime.rename_remote_titles = true` if you want NotebookLM titles to follow chunk headings
- tradeoff: the related Studio type becomes more serialized so renames stay correct

## Examples

Start from the general end-to-end workflows first. Use the partial `prepare`
examples only when you want to inspect chunking before any live NotebookLM run.

### DDD Quickly Demo

```bash
nblm run --config ./examples/workflows/ddd-quickly-demo.toml
```

### Full Learning Kit

```bash
nblm run --config ./examples/workflows/learning-kit.toml
```

### Per-Chunk Report + Slide Deck

```bash
nblm run --config ./examples/workflows/per-chunk-report-and-slides.toml
```

### Single-Studio Workflows

NotebookLM Studio is NotebookLM's built-in generation layer: Audio Overview,
Video Overview, Report, Slide Deck, Quiz, Flashcards, Infographic, Data Table,
and Mind Map.

Single-Studio end-to-end examples live under:

```text
./examples/workflows/studios/
```

Run one of them with:

```bash
nblm run --config ./examples/workflows/studios/audio.toml
```

### Chunking Only

PDF:

```bash
nblm prepare --config ./examples/workflows/pdf.toml
```

Markdown:

```bash
nblm prepare --config ./examples/workflows/markdown.toml
```

## Commands

`nblm --help`:

```text
usage: nblm [-h]
            {login,logout,doctor,init,prepare,upload,studios,run,resume} ...

Split long documents into NotebookLM-ready chunks and optionally generate
Studio outputs.

positional arguments:
  {login,logout,doctor,init,prepare,upload,studios,run,resume}
    login               Run `notebooklm login` for notebooklm-py authentication.
    logout              Clear notebooklm-py local authentication state from disk.
    doctor              Check config discovery, auth, Playwright, PDF parser, and notebooklm CLI readiness.
    init                Write a workflow config file with chunking and Studio settings.
    prepare             Parse a document and export Markdown chunks.
    upload              Upload existing chunks to NotebookLM.
    studios             Generate enabled Studio outputs for an existing notebook.
    run                 Prepare a document, create a fresh notebook run, then generate enabled Studio outputs.
    resume              Continue a previous run from `.nblm-run-state.json` and finish pending uploads or Studio jobs.
```
