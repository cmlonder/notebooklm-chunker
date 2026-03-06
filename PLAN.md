# NotebookLM Ingestor – Project Plan

## 1. Project Goal

Build an open‑source tool that prepares documents for **NotebookLM ingestion** by:

1. Parsing source documents (PDF, EPUB, HTML, Markdown).
2. Detecting headings and document structure.
3. Performing **semantic chunking** that respects heading boundaries.
4. Producing NotebookLM‑optimized chunks.
5. Automatically uploading them to NotebookLM.

Primary use case:

```
Large book / documentation
        ↓
Semantic chunking
        ↓
NotebookLM optimized sources
        ↓
Automatic upload to NotebookLM
```

The tool should also be **vendor‑independent** so the preprocessing pipeline can be reused for:

* NotebookLM
* RAG pipelines
* Vector databases
* Claude Projects
* GPT knowledge bases

---

# 2. Key Design Principles

## 2.1 Vendor Independence

The **document processing pipeline must not depend on NotebookLM**.

Architecture:

```
Document
   ↓
Parsing
   ↓
Semantic Chunking
   ↓
Exporters
   ↓
Uploader (optional layer)
```

Uploaders are pluggable:

```
uploaders/
   notebooklm
   rag
   vector_db
```

NotebookLM support will be implemented via:

```
notebooklm-py
```

This ensures the system remains reusable outside NotebookLM.

---

# 3. Supported Input Formats

Initial version should support:

```
PDF
EPUB
Markdown
HTML
```

Future support:

```
DOCX
ZIP (documentation bundles)
Git repositories
```

---

# 4. Document Parsing Layer

## Tool Choice

Primary parser:

```
unstructured
```

Reasons:

* open source
* widely used in RAG pipelines
* detects headings, paragraphs, lists
* supports many formats
* converts documents into structured elements

Example output structure:

```
Title
Heading
Paragraph
ListItem
CodeBlock
```

This allows structural chunking instead of naive splitting.

If `unstructured` is unavailable, fallback parsers may be used:

```
PyMuPDF (PDF fallback)
BeautifulSoup (HTML)
```

---

# 5. Heading Detection

Headings are the foundation of semantic chunking.

Sources for heading detection:

* unstructured element types
* font size differences
* markdown heading markers

Resulting structure example:

```
Chapter 1
   Section 1.1
   Section 1.2
Chapter 2
   Section 2.1
```

---

# 6. Semantic Chunking Algorithm

The goal is to create chunks optimized for NotebookLM.

Constraints:

```
Minimum size: ~2.5 pages
Maximum size: ~4 pages
```

Rules:

1. A chunk **must start at a heading**.
2. A chunk **should end before the next major heading**.
3. Small sections may be merged.
4. Oversized sections may be split.

Pseudo‑logic:

```
for section in sections:

    if chunk_size + section < MAX_SIZE:
        append

    else:
        finalize_chunk
        start_new_chunk
```

Chunk metadata:

```
chunk_id
source_file
chapter
page_range
```

---

# 7. Output Formats

Chunks should be exportable in multiple formats.

Primary format:

```
Markdown
```

Example:

```
# Chapter 3

## Aircraft Types

Text content...
```

Advantages:

* preserves heading hierarchy
* easy for LLM ingestion
* human readable

Optional formats:

```
PDF
TXT
JSON
```

---

# 8. NotebookLM Upload Layer

NotebookLM currently does not provide an official API.

Upload will be implemented using:

```
notebooklm-py
```

Capabilities:

* create notebook
* upload sources
* manage sources

Workflow:

```
chunks/
   001.md
   002.md
   003.md

        ↓

Uploader

        ↓

NotebookLM
```

---

# 9. CLI Interface

The project should provide a clean CLI.

Example usage:

Prepare chunks:

```
nblm prepare book.pdf
```

Upload to NotebookLM:

```
nblm upload ./chunks
```

Full pipeline:

```
nblm ingest book.pdf
```

Expected output:

```
Detected headings: 120
Chunks generated: 98
Output folder: ./chunks
Upload complete
```

CLI framework:

```
Typer
```

---

# 10. Project Architecture

```
notebooklm-ingestor

├── ingest
│   ├── pdf_parser
│   ├── epub_parser
│   ├── html_parser
│
├── chunking
│   ├── heading_detector
│   ├── semantic_chunker
│
├── exporters
│   ├── markdown_exporter
│   ├── pdf_exporter
│
├── uploaders
│   ├── notebooklm
│
├── cli
│
└── utils
```

---

# 11. Technology Stack

Core language:

```
Python
```

Libraries:

```
unstructured
PyMuPDF
BeautifulSoup
Typer
notebooklm-py
```

Automation (optional fallback):

```
Playwright
```

---

# 12. Development Roadmap

## Phase 1 – Core ingestion

Features:

* PDF parsing
* heading detection
* basic chunking
* markdown export

Goal:

```
pdf → semantic chunks
```

---

## Phase 2 – NotebookLM integration

Features:

* notebook creation
* automatic source upload

Goal:

```
pdf → chunks → notebooklm
```

---

## Phase 3 – Multi‑format ingestion

Add support:

```
EPUB
HTML
Markdown
```

---

## Phase 4 – Advanced chunking

Enhancements:

* semantic boundary detection
* paragraph grouping
* smarter size balancing

---

# 13. Future Extensions

Possible extensions:

```
RAG export
Vector database export
Automatic embeddings
Knowledge graph extraction
```

Example pipeline:

```
document
   ↓
semantic chunking
   ↓
multiple outputs
   ↓
NotebookLM / RAG / VectorDB
```

---

# 14. Example End‑to‑End Workflow

User command:

```
nblm ingest aviation_book.pdf
```

Pipeline:

```
PDF
↓
Document parsing
↓
Heading detection
↓
Semantic chunking
↓
Markdown chunks
↓
NotebookLM upload
```

Result:

```
NotebookLM notebook
with 100+ optimized sources
```

---

# 15. Project Vision

This project aims to become:

```
The document ingestion pipeline for NotebookLM and LLM knowledge systems.
```

Instead of manually preparing documents, developers can run a single command to transform large documents into **LLM‑ready knowledge sources**.
