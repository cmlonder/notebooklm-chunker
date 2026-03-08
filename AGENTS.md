# AGENTS.md

This file captures the repo-specific working rules that were settled while
building `notebooklm-chunker`. Prefer these rules over ad hoc choices when
making future changes.

## Product Model

- One `chunking.output_dir` represents one NotebookLM workflow lineage.
- A workflow lineage owns:
  - chunk markdown files
  - `manifest.json`
  - `.nblm-run-state.json`
- If the user wants another book, or the same book as a separate NotebookLM
  run, use a different `chunking.output_dir`.

## Run Semantics

- `nblm run` always starts a fresh run.
- `nblm resume` is the explicit continuation path for an existing
  `.nblm-run-state.json`.
- `nblm studios` may reuse `.nblm-run-state.json` to add new Studio outputs
  later without re-uploading chunk files.
- For `per_chunk = true`, Studio generation must stay scoped to the saved
  chunk source IDs from the same run state.
- Do not silently fall back from per-chunk behavior to whole-notebook behavior.

## Queueing And Quotas

- Source uploads and Studio jobs are separate queues.
- New source uploads should keep moving even while earlier Studio jobs are
  still running.
- Quota exhaustion is a first-class state:
  - record the estimated retry time in `.nblm-run-state.json`
  - report it clearly to the user
  - exit instead of hammering NotebookLM
- Quota blocks are Studio-specific, not global. A blocked `report` queue
  should not automatically block `quiz`, `slide_deck`, or other Studio types.
- `resume` and `studios` should warn before retrying while the saved quota
  block is still active.

## Output Directory Behavior

- Fresh `prepare` and fresh `run` should ask before writing into a non-empty
  chunk output directory.
- `resume` should not behave like a fresh overwrite.
- `--yes` is the explicit opt-in to skip overwrite or quota warning prompts.

## Naming Rules

- Chunk filenames should use the content heading, not random NotebookLM names.
- Remove heading numbers like `1.1`, `4.2.3` from the user-facing chunk title.
- Keep a stable sortable prefix like `c001-...` so NotebookLM string sorting
  remains correct.
- When PDF running headers or footers repeat on many pages, do not let them
  dominate chunk naming.

## README Rules

- README should be package-manager-first, not repo-clone-first.
- Quick Start should lead with:
  - `nblm init`
  - `nblm run`
  - `nblm resume`
  - `nblm studios` later-addition example
- Repo-only examples must be labeled as repo demos.
- Keep `Requirements` minimal.
- Keep `Installation` focused on the main user path, not every optional mode.
- Avoid unnecessary explanatory text when a shorter sentence communicates the
  same thing.

## Config Rules

- `source.path` belongs in the workflow file.
- `chunking.output_dir` and Studio output paths may use `{source_stem}`.
- Paths in workflow files are resolved relative to the workflow file.
- `runtime.download_outputs = false` is a valid shipped mode. Completed Studio
  state must not depend on a local downloaded artifact file being present.

## Release Rules

- When changing the released package version, update both:
  - `pyproject.toml`
  - `notebooklm_chunker/__init__.py`
- Before release:
  - run `python3 -m unittest discover -s tests -v`
  - run `python -m build`
  - run `python -m twine check dist/*`
- If `python -m build` fails because `build` is missing, install the dev extra
  first instead of changing the packaging config.
- After publishing, verify the real installed binary in a clean virtual
  environment, not just the editable install.

## Testing Rules

- Prefer the full suite:
  - `python3 -m unittest discover -s tests -v`
- Add tests whenever changing:
  - CLI behavior
  - run state format or semantics
  - uploader concurrency, retry, quota, or resume behavior
  - parser heading or skip logic

## Documentation Sync

- If behavior changes in CLI or workflow semantics, update `README.md`.
- If release, packaging, or local verification practice changes, update
  `DEVELOPMENT.md`.
- Keep docs aligned with the actual shipped CLI behavior; do not document
  unpublished behavior as if it is already on PyPI.
