# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- PDF chunking now uses the document's embedded table of contents (bookmarks)
  when present: heading text and hierarchy levels come from the publisher's
  outline instead of text heuristics
- Chunk boundary planning prefers cutting at chapter-level headings over
  sub-section headings (level-weighted splitting)
- Video Studio: `format = "cinematic"`, `style = "custom"` with a new
  `style_prompt` option
- Infographic Studio: new `style` option (11 values, e.g. `bento-grid`,
  `sketch-note`, `professional`)
- Experimental PyInstaller sidecar build (`scripts/build_sidecar.sh`) so the
  desktop app can bundle `nblm` and run without a system Python install
- Desktop: HTML-escaping for all user-controlled strings in rendered lists
- Ruff for linting and formatting
- Mypy for type checking
- Coverage reporting with 80% minimum threshold
- Python 3.13 support
- Separate CI jobs for lint, typecheck, test, and build
- Install verification in CI
- CONTRIBUTING.md with development guidelines
- SECURITY.md with security policy
- CHANGELOG.md for tracking changes
- Issue and PR templates

### Changed
- notebooklm-py dependency pinned to `>=0.7.3,<0.8` (the library ships
  breaking changes per minor release)
- Chunk source titles are now sent with the upload itself instead of a
  separate rename call (one fewer RPC per chunk)
- Repeated PDF running headers that embed page numbers
  (e.g. `16|Book Title`) are now filtered out instead of being mistaken for
  headings
- Studio job execution is table-driven internally; all nine studio types run
  through one tested code path
- CI workflow split into distinct jobs

### Fixed
- Quiz and flashcards generation crashed against notebooklm-py 0.7.x because
  the upstream `QuizQuantity.MORE` option was removed; `quantity = "more"` in
  existing configs now maps to `standard`
- Mind map generation recorded no artifact ID with notebooklm-py >= 0.7
  (typed `MindMapResult` was not read)
- `nblm --version` reported 0.2.1 while the package version was 0.5.0
- A config where `target_pages` is below `min_pages` now treats `min_pages`
  as the effective target instead of silently planning with an
  unsatisfiable preference
- Dev dependencies expanded with quality tools

## [0.2.1] - 2024-XX-XX

### Added
- Initial public release
- PDF chunking with configurable size limits
- NotebookLM workflow automation
- Studio output generation (reports, slides, quizzes, etc.)
- Resume capability for interrupted runs
- Quota handling and retry logic
- Per-chunk and whole-notebook Studio modes

[Unreleased]: https://github.com/cmlonder/notebooklm-chunker/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/cmlonder/notebooklm-chunker/releases/tag/v0.2.1
