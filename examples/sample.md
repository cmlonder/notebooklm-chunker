# Sample NotebookLM Chunker Document

This file exists so the documented local commands work out of the box.

## Why this project exists

Long documents are easier to ingest when chunk boundaries follow headings and
section structure instead of arbitrary character counts.

## Local smoke test

You can run `nblm prepare ./examples/sample.md -o ./chunks` to verify the CLI,
parser, chunker, and exporter pipeline on a known-good input file.

## Next step

Replace this file with your own Markdown, HTML, EPUB, TXT, or PDF document when
you are ready to process real content.
