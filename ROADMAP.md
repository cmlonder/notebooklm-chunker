## Summary

Current CI/CD is functional but still minimal. The repo already has:
- unit tests
- package build
- `twine check`
- PyPI trusted publishing

It does **not** yet have a mature OSS quality pipeline. Missing or underpowered areas:
- lint / format checks
- type checking
- coverage reporting and thresholds
- dependency and supply-chain scanning
- static security analysis
- PR/release governance files
- install verification in CI after packaging
- ongoing dependency update automation

`Trivy` should be added, but not alone. For this repo, the right baseline is:
- `ruff` for lint + format check
- `mypy` for type check
- `coverage.py` on top of `unittest`
- `pip-audit` for Python dependency vulnerabilities
- `trivy fs` for filesystem / dependency / secret / config scanning
- `CodeQL` for static security analysis
- `Dependabot` for dependency + GitHub Actions updates

Roadmap priority should be **balanced**, but the first phase should still lock in OSS trust and release hygiene before broadening feature scope.

## Technical Roadmap

### Phase 1 — OSS Baseline

Focus: make the project trustworthy to install, contribute to, and release.

Deliverables:
- [x] Add `ruff` to the project and enforce:
    - [x] lint check in CI
    - [x] formatting check in CI
    - [x] import cleanup through Ruff only, no separate isort
- [x] Add `mypy` with an initial pragmatic config:
    - [x] type-check `notebooklm_chunker`
    - [x] allow incremental adoption where needed
    - [x] do not block on perfect typing in the first pass; use targeted ignores only where necessary
- [x] Add coverage reporting:
    - [x] run tests under `coverage`
    - [x] publish terminal summary in CI
    - [x] enforce an initial minimum threshold
    - [x] start with `80%` line coverage minimum (set to 79% for pragmatic initial baseline, currently at 79.66%)
- [x] Expand CI workflow into distinct jobs:
    - [x] `lint`
    - [x] `typecheck`
    - [x] `test`
    - [x] `build`
- [x] Keep Python support checked at least on:
    - [x] `3.12`
    - [x] `3.13`
- [x] Add GitHub repo hygiene files:
    - [x] `CONTRIBUTING.md`
    - [x] `SECURITY.md`
    - [x] `CHANGELOG.md`
    - [x] issue templates
    - [x] PR template
- [x] Add badges to README:
    - [x] PyPI version
    - [x] CI
    - [x] license
    - [x] Python version
- [x] Add install verification to CI:
    - [x] build wheel
    - [x] install built artifact in a fresh venv
    - [x] run `nblm --version`
    - [x] run `nblm --help`

### Phase 2 — Reliability And Operability

Focus: make long-running NotebookLM workflows safer and more observable.

Deliverables:
- [ ] Add `dry-run` mode:
    - [ ] show chunk count
    - [ ] show skip range result
    - [ ] show which Studio jobs would be created
    - [ ] show output directories and run-state location
- [ ] Add structured run summary output:
    - [ ] uploaded source count
    - [ ] completed Studio jobs by type
    - [ ] pending jobs by type
    - [ ] quota-blocked Studio types
- [ ] Add better run-state introspection:
    - [ ] a human-readable `nblm status --config ...`
    - [ ] summarize pending / completed / failed / blocked jobs
- [ ] Add resumable retry timestamps per Studio type to user-facing status output
- [ ] Add optional artifact fetch workflow:
    - [ ] fetch previously completed remote artifacts later
    - [ ] useful when `download_outputs = false`
- [ ] Add clearer config validation and warnings:
    - [ ] detect risky shared `output_dir`
    - [ ] detect impossible skip ranges
    - [ ] detect missing `output_dir` for `per_chunk = true`
- [ ] Add log level control:
    - [ ] quiet
    - [ ] normal
    - [ ] verbose

### Phase 3 — AI Workflow Product Expansion

Focus: broaden the project from “PDF chunker” to a reusable NotebookLM workflow orchestrator.

Deliverables:
- [ ] Support more source types as first-class workflow inputs:
    - [ ] URLs
    - [ ] plain text / pasted text
    - [ ] Markdown directories
    - [ ] local HTML bundles
    - [ ] EPUB as a documented primary path, not just parser capability
- [ ] Add workflow presets:
    - [ ] `learning-kit`
    - [ ] `per-chunk-slides`
    - [ ] `per-chunk-report`
    - [ ] `quiz-only`
    - [ ] `research-notebook`
- [ ] Add prompt packs:
    - [ ] domain analysis
    - [ ] study guide
    - [ ] engineering explainer
    - [ ] executive summary
    - [ ] language learning
- [ ] Add evaluation samples for prompt quality:
    - [ ] known-input / known-output demo runs
    - [ ] goldens for chunk naming and chunk boundary behavior
- [ ] Add optional metadata/tag strategy:
    - [ ] local manifest metadata per chunk
    - [ ] future remote tagging when supported
- [ ] Add notebook augmentation flows:
    - “sources first, studios later” as a documented product path
    - [ ] workflow layering across multiple runs
- [ ] Add multimodal roadmap placeholders:
    - [ ] image-heavy PDFs
    - [ ] scanned PDFs with OCR fallback
    - [ ] future video/audio source handling if upstream stabilizes

## Security And Supply-Chain Plan

This should be explicit in the roadmap, not hidden under CI.

Deliverables:
- [ ] Add `pip-audit` to CI on every PR/push
- [ ] Add `trivy` in filesystem scan mode on every PR/push
- [ ] Add `CodeQL` as a scheduled and PR security workflow
- [ ] Add `Dependabot` for:
    - [ ] Python dependencies
    - [ ] GitHub Actions
- [x] Add secret scanning guidance in `SECURITY.md`
- [ ] Pin GitHub Actions to stable major versions at minimum now, and move to commit-SHA pinning later
- [ ] Add release provenance hardening as a later milestone:
    - [ ] artifact attestation / provenance if kept simple enough for this repo
- [ ] Make security findings non-blocking at first only if signal is noisy; otherwise block PRs on:
    - [ ] high/critical dependency vulnerabilities
    - [ ] broken lint/type/build/test jobs

## Feature Backlog

Include a separate backlog section in `ROADMAP.md` so product ideas are visible apart from technical hygiene.

Top-priority product items:
- `nblm dry-run`
- `nblm status`
- fetch/download completed remote artifacts later
- workflow presets
- prompt pack examples
- better OCR/scanned PDF handling
- richer chunk diagnostics

Mid-priority product items:
- URL and web-source workflows
- bulk source ingestion beyond single-document runs
- chunk quality heuristics and heading cleanup improvements
- notebook-level aggregate artifact generation after per-chunk pass
- exportable run report for sharing or debugging

Longer-term AI-native items:
- evaluation harness for prompt templates
- domain-specific workflow bundles
- guided study paths across chunks
- artifact post-processing and consolidation
- comparative multi-document notebook workflows

## Release And Quality Gates

Add a dedicated section in the roadmap that defines “done” for releases.

Required gates for every release:
- `ruff check`
- `ruff format --check`
- `mypy`
- `coverage` threshold pass
- full unittest suite
- package build
- `twine check`
- fresh install verification from built artifact
- fresh install verification from PyPI after publish

Recommended later gates:
- `pip-audit`
- `trivy`
- `CodeQL`
- changelog entry required before release
- release notes derived from changelog

## Success Criteria

Treat the roadmap as complete when these are true:
- A new contributor can clone, install, lint, type-check, test, and build from docs alone.
- A PR cannot merge with broken lint, types, tests, or packaging.
- A release cannot go out without artifact build and install verification.
- Security scans run continuously and surface actionable findings.
- Long NotebookLM runs are inspectable, resumable, and understandable.
- The project reads like a reusable NotebookLM workflow tool, not just a one-off PDF script.

## Assumptions And Defaults

- Priority is **balanced**, but Phase 1 still lands first because OSS trust is a prerequisite for growth.
- Roadmap horizon is **near-term and execution-oriented**, not a long 1-year strategy doc.
- Existing `unittest` is kept; no framework migration to `pytest` is required now.
- `Trivy` is included, but as one layer in a broader security stack, not the only security control.
- The roadmap should optimize for both open-source usability and AI workflow expansion, with NotebookLM remaining the primary target platform.
