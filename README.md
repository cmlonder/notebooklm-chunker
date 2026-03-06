# notebooklm-chunker

Uploading one large PDF to NotebookLM usually produces shallow Studio results.
Video Overview, Report, Slide Deck, Quiz, and similar outputs end up working
against one giant blob of context, so they stay short, generic, and harder to
reuse as a learning flow.

`notebooklm-chunker` fixes that by splitting a long document into meaningful,
heading-aware chunks, uploading each chunk as a separate source, and then
generating the NotebookLM Studio outputs you enable from one workflow file.
The result is closer to an interactive learning kit than a single uploaded PDF.

For long books, do not keep the workflow fully sequential by default. Start
with `runtime.max_parallel_chunks = 5` so uploads and per-chunk Studio jobs
move in parallel without opening too many concurrent NotebookLM tasks at once.

## Demo

This repository ships with a full demo built around the freely downloadable
InfoQ mini-book
[Domain-Driven Design Quickly](https://www.infoq.com/minibooks/domain-driven-design-quickly/).

Demo goal:
- Take a real DDD book, split it into heading-aware 2.5-4 page chunks, and
  turn it into an interactive learning kit.
- Generate one slide deck and one question-answer style report per chunk so the
  reader can study DDD chapter by chapter instead of reading one flat PDF.
- Run with `runtime.max_parallel_chunks = 5` so the demo processes five chunk
  pipelines in parallel.

Demo command:

```bash
nblm run --config ./examples/workflows/ddd-quickly-demo.toml
```

Demo files:
- Workflow file: `./examples/workflows/ddd-quickly-demo.toml`
- Source PDF: `./examples/ddd-quickly.pdf`

Demo result:
- NotebookLM notebook: `[add-your-link-here](https://notebooklm.google.com/)`
- Markdown chunks under `./examples/workflows/output/ddd-quickly/chunks`
- One per-chunk report under `./examples/workflows/output/ddd-quickly/reports`
- One per-chunk slide deck under `./examples/workflows/output/ddd-quickly/slides`

## Requirements

- Python 3.12+
- `pip`
- A NotebookLM account
- Use the same Python interpreter for install and Playwright setup

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

Installing the package exposes the `nblm` CLI.

To clear local notebooklm-py authentication state later:

```bash
nblm logout
```

## Quick Start

Generate a starter workflow file:

```bash
nblm init
```

Edit `source.path` and any workflow settings you need, then check what is
missing before the first live run:

```bash
nblm doctor --config ./nblm.toml
```

Then run the whole flow:

```bash
nblm run --config ./nblm.toml
```

`source.path` lives in the config file, so you do not need to pass the input
document as a CLI argument unless you want to override it.

## Workflow File

Below is a full example that shows all supported workflow sections and the
practical options you are likely to use:

```toml
[source]
# Relative paths are resolved from this TOML file.
path = "./your-document.pdf"
# PDF only: skip explicit inclusive page ranges as well.
# Useful for contents, foreword, references, appendix, or index pages.
# skip_ranges = ["1-8", "399-420", "512"]

[notebook]
# Create a new notebook with this title unless `id` is set.
title = "Interactive Learning Notebook"
# id = "nb_..."

[chunking]
# Markdown chunks and manifest.json are written here.
output_dir = "./output/chunks"
# Preferred chunk size.
target_pages = 3.0
# Soft lower bound.
min_pages = 2.5
# Hard upper bound.
max_pages = 4.0
# Word heuristic used when page boundaries are unavailable or noisy.
words_per_page = 500

[runtime]
# Process up to N chunk upload + per-chunk Studio pipelines in parallel.
# Leave this at 1 to keep the run fully sequential.
max_parallel_chunks = 1

[studios.audio]
enabled = false
# Local download filename for the generated NotebookLM Studio artifact.
output_path = "./output/studio/audio-overview.mp4"
language = "en"
format = "deep-dive"
length = "long"
prompt = """
Create an energetic audio overview that emphasizes
the big ideas and real-world implications.
"""

[studios.video]
enabled = false
output_path = "./output/studio/video-overview.mp4"
language = "en"
format = "explainer"
style = "whiteboard"
prompt = """
Turn this into a visual lesson with clear examples
and a teacher-style narrative.
"""

[studios.report]
enabled = false
# Set `per_chunk = true` to generate one report per uploaded chunk.
per_chunk = false
# If `per_chunk = true`, prefer `output_dir` over `output_path`.
# output_dir = "./output/studio/reports"
output_path = "./output/studio/study-guide.md"
language = "en"
format = "study-guide"
prompt = """
Focus on key arguments, terminology, and what a student
should review after reading.
"""

[studios.slide_deck]
enabled = false
# Set `per_chunk = true` to generate one deck per uploaded chunk.
per_chunk = false
# If `per_chunk = true`, prefer `output_dir` over `output_path`.
# output_dir = "./output/studio/slides"
output_path = "./output/studio/slide-deck.pdf"
language = "en"
format = "detailed"
length = "default"
download_format = "pdf"
prompt = """
Build a teaching deck with strong section transitions
and presenter-friendly structure.
"""

[studios.quiz]
enabled = false
output_path = "./output/studio/quiz.json"
quantity = "more"
difficulty = "hard"
download_format = "json"
prompt = """
Ask concept-check questions that reveal whether
the learner really understood the text.
"""

[studios.flashcards]
enabled = false
output_path = "./output/studio/flashcards.md"
quantity = "more"
difficulty = "hard"
download_format = "markdown"
prompt = """
Turn the important terms, definitions, and examples
into compact recall cards.
"""

[studios.infographic]
enabled = false
output_path = "./output/studio/infographic.png"
language = "en"
orientation = "portrait"
detail = "detailed"
prompt = """
Highlight the process, the main entities,
and the most memorable comparisons.
"""

[studios.data_table]
enabled = false
output_path = "./output/studio/data-table.csv"
language = "en"
prompt = """
Create a comparison table of the most important concepts,
examples, and takeaways.
"""

[studios.mind_map]
enabled = false
output_path = "./output/studio/mind-map.json"
# notebooklm-py does not expose a custom prompt surface for mind maps today.
```

**General Notes**
- NotebookLM-side artifact titles are controlled by NotebookLM. Local filenames are controlled by `output_path` or `output_dir`.
- CLI override is available too: `--skip-range 1-8 --skip-range 399-420`.
- `nblm logout` removes local notebooklm-py auth files under `NOTEBOOKLM_HOME` or `~/.notebooklm/`.
- If you use `NOTEBOOKLM_AUTH_JSON`, `nblm logout` cannot clear that environment variable for you.

## Studio Parameters

The runtime defaults are intentionally set to the richer / fuller side. If you
leave a field blank, `nblm` will prefer the more complete option rather than a
short or lightweight one.

### Common Fields

| Field | Meaning |
| --- | --- |
| `enabled` | Turns that Studio output on or off. |
| `per_chunk` | Generate one artifact per uploaded chunk instead of one artifact for the whole notebook. |
| `prompt` | Extra instructions for NotebookLM. Use TOML multiline strings for anything non-trivial. |
| `output_path` | Single output file location. Best for notebook-level generation. |
| `output_dir` | Output folder for `per_chunk = true`. |
| `language` | Output language when the Studio supports it. |

### Audio Overview

| Field | Allowed Values | Default |
| --- | --- | --- |
| `format` | `deep-dive`, `brief`, `critique`, `debate` | `deep-dive` |
| `length` | `short`, `default`, `long` | `long` |

### Video Overview

| Field | Allowed Values | Default |
| --- | --- | --- |
| `format` | `explainer`, `brief` | `explainer` |
| `style` | `auto`, `classic`, `whiteboard`, `kawaii`, `anime`, `watercolor`, `retro-print`, `heritage`, `paper-craft` | `whiteboard` |

### Report

| Field | Allowed Values | Default |
| --- | --- | --- |
| `format` | `briefing-doc`, `study-guide`, `blog-post`, `custom` | `study-guide` |

If `format = "custom"`, `prompt` is sent as the main custom report prompt. For
the built-in report formats, `prompt` is appended as extra instructions.

### Slide Deck

| Field | Allowed Values | Default |
| --- | --- | --- |
| `format` | `detailed`, `presenter` | `detailed` |
| `length` | `default`, `short` | `default` |
| `download_format` | `pdf`, `pptx` | `pdf` |

### Quiz

| Field | Allowed Values | Default |
| --- | --- | --- |
| `quantity` | `fewer`, `standard`, `more` | `more` |
| `difficulty` | `easy`, `medium`, `hard` | `hard` |
| `download_format` | `json`, `markdown`, `html` | `json` |

### Flashcards

| Field | Allowed Values | Default |
| --- | --- | --- |
| `quantity` | `fewer`, `standard`, `more` | `more` |
| `difficulty` | `easy`, `medium`, `hard` | `hard` |
| `download_format` | `json`, `markdown`, `html` | `markdown` |

### Infographic

| Field | Allowed Values | Default |
| --- | --- | --- |
| `orientation` | `landscape`, `portrait`, `square` | `portrait` |
| `detail` | `concise`, `standard`, `detailed` | `detailed` |

### Data Table

| Field | Allowed Values | Default |
| --- | --- | --- |
| `language` | any language code or label NotebookLM accepts | `en` |
| `prompt` | custom table instructions | built-in comparison prompt |

### Mind Map

| Field | Allowed Values | Default |
| --- | --- | --- |
| `output_path` | JSON output path | `./output/studio/mind-map.json` |

`notebooklm-py` does not currently expose a custom prompt surface for mind
maps, so `prompt` is ignored there.

## Examples

Most users should start with an end-to-end `nblm run` workflow. The partial
`prepare` examples are for cases where you only want to inspect or export
chunks before doing live NotebookLM work.

### DDD Quickly Demo

Use the bundled DDD mini-book and the dedicated DDD teaching prompts:

```bash
nblm run --config ./examples/workflows/ddd-quickly-demo.toml
```

### Full Learning Kit

Use the generic end-to-end demo when you want to chunk a document, upload the
resulting sources, and generate multiple NotebookLM Studio outputs in one run:

```bash
nblm run --config ./examples/workflows/learning-kit.toml
```

### Per-Chunk Report + Slide Deck

Use this when the main goal is to study a long document section by section,
with one report and one slide deck generated for every chunk:

```bash
nblm run --config ./examples/workflows/per-chunk-report-and-slides.toml
```

### Studio Workflows

NotebookLM Studio is NotebookLM's built-in content generation surface:
Audio Overview, Video Overview, Report, Slide Deck, Quiz, Flashcards,
Infographic, Data Table, and Mind Map. These workflows are still end-to-end,
but each one focuses on a single Studio capability with a dedicated prompt:

- Audio Overview: `./examples/workflows/studios/audio.toml`
- Video Overview: `./examples/workflows/studios/video.toml`
- Report / Study Guide: `./examples/workflows/studios/report.toml`
- Slide Deck: `./examples/workflows/studios/slide-deck.toml`
- Quiz: `./examples/workflows/studios/quiz.toml`
- Flashcards: `./examples/workflows/studios/flashcards.toml`
- Infographic: `./examples/workflows/studios/infographic.toml`
- Data Table: `./examples/workflows/studios/data-table.toml`
- Mind Map: `./examples/workflows/studios/mind-map.toml`

Run any of them with:

```bash
nblm run --config ./examples/workflows/studios/audio.toml
```

### PDF Chunking Only

If you only need to inspect chunk boundaries, validate skip ranges, or prepare
Markdown chunks before uploading anything to NotebookLM, use:

```bash
nblm prepare --config ./examples/workflows/pdf.toml
```

You can always upload or run Studio generation later with those exported
chunks.

### Markdown Chunking Only

If your source is already Markdown and you only want the chunk export step, use:

```bash
nblm prepare --config ./examples/workflows/markdown.toml
```

## End-to-End Demo

Use this workflow:

- `./examples/workflows/ddd-quickly-demo.toml`

What that file currently says:

- `source.path = "../ddd-quickly.pdf"`
- `skip_ranges = ["1-10", "99-106"]`
- `target_pages = 3.0`
- `min_pages = 2.5`
- `max_pages = 4.0`
- `runtime.max_parallel_chunks = 5`
- `studios.report.per_chunk = true`
- `studios.slide_deck.per_chunk = true`

Run it with:

```bash
nblm run --config ./examples/workflows/ddd-quickly-demo.toml
```

What happens:

1. The PDF is parsed, with `skip_ranges` applied first if you set them.
2. The chunker looks for heading boundaries and tries to build chunks around `target_pages = 3.0`, while staying within `2.5 - 4.0` whenever possible.
3. `runtime.max_parallel_chunks = 5` keeps up to five chunk pipelines in flight at once, so upload plus per-chunk report/slide generation does not bottleneck on a fully sequential run.
4. Each chunk is exported as a separate Markdown file under `./examples/workflows/output/ddd-quickly/chunks`.
5. Each Markdown chunk is uploaded to NotebookLM as a separate source.
6. Because `studios.report.per_chunk = true`, one study-guide style report is generated for each uploaded chunk.
7. Because `studios.slide_deck.per_chunk = true`, one teaching slide deck is generated for each uploaded chunk.
8. Reports land in `./examples/workflows/output/ddd-quickly/reports`, slide decks land in `./examples/workflows/output/ddd-quickly/slides`.

For a smaller runnable local chunking demo, the bundled PDF workflow:

```bash
nblm prepare --config ./examples/workflows/pdf.toml
```

currently produces:

```text
Detected headings: 9
Chunks generated: 3
Output folder: /.../examples/workflows/output/pdf/chunks
```

## Commands

The CLI has built-in help through `nblm --help`:

```text
usage: nblm [-h] {login,logout,doctor,init,prepare,upload,studios,run} ...

Split long documents into NotebookLM-ready chunks and optionally generate
Studio outputs.

positional arguments:
  {login,logout,doctor,init,prepare,upload,studios,run}
    login               Run `notebooklm login` for notebooklm-py
                        authentication.
    logout              Clear notebooklm-py local authentication state from
                        disk.
    doctor              Check config discovery, auth, Playwright, PDF parser,
                        and notebooklm CLI readiness.
    init                Write a workflow config file with chunking and Studio
                        settings.
    prepare             Parse a document and export Markdown chunks.
    upload              Upload existing chunks to NotebookLM.
    studios             Generate enabled Studio outputs for an existing
                        notebook.
    run                 Prepare a document, upload the chunks, then generate
                        enabled Studio outputs.

options:
  -h, --help            show this help message and exit
```
