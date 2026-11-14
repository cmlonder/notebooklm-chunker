# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-11-15

### Added
- Desktop Studio Builder can now queue all nine Studio types: video,
  infographic, mind map and data table join report, slide deck, quiz,
  flashcards and audio, each with its own settings, prompt library and tab
- Desktop artifact preview plays downloaded videos, shows infographic images
  inline and renders mind maps as an outline

### Fixed
- Desktop: the video settings dialog on the dashboard did not refresh when
  the style changed, so the custom style prompt field never appeared there
- Desktop: workflow preset icons rendered as plain text

## [0.6.0] - 2026-11-15

### Added
- Video Studio: `format = "short"` for short-form videos
- Report Studio: `format = "concept-explanation"`
- Mind map Studio: `format = "interactive"` generates the Studio-panel mind
  map (default stays `note-backed`), and `prompt` / `language` are now sent
- Quiz and flashcards in the desktop app: `more` quantity and HTML download
- Multi-account support: `nblm --profile <name>` on every auth-touching command,
  `nblm login --account <email>` / `--all-accounts`, and `nblm profile ...`
  passthrough (list, create, switch, rename, delete)
- `nblm list-profiles` prints auth profiles with account email and active flag
  as JSON for desktop integrations
- Desktop account switcher: pick the active account on the setup screen or add a
  new one; every engine call is scoped to the selected profile
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
- Requires `notebooklm-py` 0.8.6 or newer (`>=0.8.6,<0.9`). Google moved
  NotebookLM to `notebook.google.com`; older `notebooklm-py` never detects a
  finished browser sign-in on the new address, so `nblm login` hung until it
  timed out
- `nblm doctor` now asks NotebookLM whether the saved session still signs in
  and reports an expired session as `WARN auth` instead of `OK`. When
  NotebookLM cannot be reached, the saved session is still reported as present
- Quiz and flashcards `quantity = "more"` is sent as its own value again
  instead of being downgraded to `standard`
- Studio quota blocks are detected from NotebookLM's refusal code as well as
  the message text, so a refusal with different wording still records the
  quota block and exits
- Chunk source titles are now sent with the upload itself instead of a
  separate rename call (one fewer RPC per chunk)
- Repeated PDF running headers that embed page numbers
  (e.g. `16|Book Title`) are now filtered out instead of being mistaken for
  headings
- Studio job execution is table-driven internally; all nine studio types run
  through one tested code path
- CI workflow split into distinct jobs

### Fixed
- Desktop Studio settings offered values the engine rejects (report
  `timeline` / `faq`, quiz difficulty `easier` / `default`, audio
  `conversational`), so those jobs failed with a config error. The lists now
  come from one table that mirrors the engine, audio gains `brief`,
  `critique` and `debate`, report gains `blog-post`, and previously saved
  invalid values are migrated to the closest valid one
- Auth detection failed against notebooklm-py 0.7, which moved auth state into
  per-profile directories (`profiles/<name>/`); `nblm doctor` reported "not
  signed in" and the desktop app showed "login is not ready" even after a
  successful login. Logout also silently failed to clear the new-layout session.
  `nblm doctor` now also reports which profile/account is active
- Quiz and flashcards generation crashed against notebooklm-py 0.7.x because
  the upstream `QuizQuantity.MORE` option was removed
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

[Unreleased]: https://github.com/cmlonder/notebooklm-chunker/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/cmlonder/notebooklm-chunker/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/cmlonder/notebooklm-chunker/compare/v0.5.0...v0.6.0
[0.2.1]: https://github.com/cmlonder/notebooklm-chunker/releases/tag/v0.2.1
