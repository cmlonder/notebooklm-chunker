# Multi-Chunk Demo Document

This example is intentionally written to produce multiple Markdown chunk files
when you run `prepare` with the demo settings documented in the README and
development guide.

## Source Intake

A practical ingestion pipeline starts before any upload call is made. Someone
has to pick a source document, check that it is readable, and decide whether
the file should be processed as one large object or as a set of smaller,
section-aware pieces. When that early decision is skipped, the later system
usually compensates with blunt chunking rules that cut through chapter
boundaries and make the final notebook harder to navigate. A structured intake
step keeps the workflow honest. It gives the parser a clear starting point,
preserves the author’s section hierarchy, and makes the exported chunk files
look like deliberate knowledge artifacts instead of arbitrary fragments. That
is especially useful when the next step is NotebookLM, because each uploaded
source should read like a coherent note rather than a random slice from the
middle of a long document.

## Structural Parsing

After intake, the parser needs to convert the raw file into a normalized
internal model. That model does not need to be complicated, but it does need to
be stable. Headings should be headings, paragraphs should be paragraphs, and
page information should be attached whenever the source format can provide it.
Once the parsing layer emits a consistent structure, the chunker can stay
vendor-independent and avoid format-specific hacks. Markdown, HTML, EPUB, and
PDF may all arrive through different code paths, yet the chunker should still
see the same conceptual building blocks. This is where the project earns its
reusability. If the core model remains small and predictable, new file formats
can be added without rewriting the chunking logic or the export layer every
time a parser implementation changes upstream.

## Export And Upload

The last stage is where the demo becomes easy to inspect. The tool writes each
chunk as its own Markdown file, names the files deterministically, and records a
manifest that explains what was produced. That directory can then be uploaded as
a set of separate NotebookLM sources. In other words, the upload step is not
sending one merged document back into the system; it is iterating over the
exported chunk files one by one. This is the behavior most users expect when
they say they want semantic chunking for NotebookLM. They want a source folder
that is understandable on disk, reviewable before upload, and safe to reuse in
other pipelines later. A good demo should therefore show more than a single
output file. It should show a small directory of chunk files that can be
uploaded individually and inspected independently.
