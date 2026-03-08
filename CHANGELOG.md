# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- CI workflow split into distinct jobs
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
