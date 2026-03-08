from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from notebooklm_chunker.run_state import RunStateStore, chunk_content_hash


class RunStateStoreTests(unittest.TestCase):
    def test_uploaded_chunk_sources_returns_uploaded_chunks_in_filename_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / ".nblm-run-state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "notebook_id": "nb1",
                        "chunks": {
                            "c010-summary.md": {
                                "content_hash": "hash-10",
                                "source": {"status": "uploaded", "source_id": "src-10", "remote_title": "C010 Summary"},
                                "studios": {},
                            },
                            "c002-intro.md": {
                                "content_hash": "hash-2",
                                "source": {"status": "uploaded", "source_id": "src-2", "remote_title": "C002 Intro"},
                                "studios": {},
                            },
                            "c005-pending.md": {
                                "content_hash": "hash-5",
                                "source": {"status": "pending", "source_id": None, "remote_title": None},
                                "studios": {},
                            },
                        },
                        "notebook_studios": {},
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            state = RunStateStore.load(state_path)

        self.assertEqual(
            state.uploaded_chunk_sources(),
            [
                {"file_name": "c002-intro.md", "source_id": "src-2", "remote_title": "C002 Intro"},
                {"file_name": "c010-summary.md", "source_id": "src-10", "remote_title": "C010 Summary"},
            ],
        )

    def test_load_migrates_legacy_v1_chunk_and_studio_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunk_path = root / "001-intro.md"
            chunk_path.write_text("# Intro\n\nBody\n", encoding="utf-8")
            content_hash = chunk_content_hash(chunk_path)
            state_path = root / ".nblm-run-state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "notebook_id": "nb-legacy",
                        "notebook_title": "Legacy Notebook",
                        "chunks": {
                            "001-intro.md": {
                                "content_hash": content_hash,
                                "source_id": "src-001-intro",
                                "remote_title": "C001 Intro",
                                "studios": {
                                    "slide_deck": {
                                        "status": "pending",
                                        "task_id": "task-slide-1",
                                        "output_path": str(root / "slides" / "001-intro.pdf"),
                                        "error": "still running",
                                    }
                                },
                            }
                        },
                        "notebook_studios": {},
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            state = RunStateStore.load(state_path)

        uploaded_source = state.uploaded_source("001-intro.md", content_hash=content_hash)
        self.assertEqual(uploaded_source, ("src-001-intro", "C001 Intro"))
        pending_slide = state.pending_chunk_studio(
            file_name="001-intro.md",
            studio_name="slide_deck",
            content_hash=content_hash,
        )
        assert pending_slide is not None
        self.assertEqual(pending_slide["status"], "pending")
        self.assertEqual(pending_slide["task_id"], "task-slide-1")
        self.assertEqual(pending_slide["last_error"], "still running")

    def test_write_uses_explicit_source_and_studio_job_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunk_path = root / "001-intro.md"
            chunk_path.write_text("# Intro\n\nBody\n", encoding="utf-8")
            content_hash = chunk_content_hash(chunk_path)
            state_path = root / ".nblm-run-state.json"
            state = RunStateStore(state_path)

            async def scenario() -> None:
                await state.set_notebook(notebook_id="nb1", notebook_title="Notebook")
                await state.record_source_state(
                    file_name="001-intro.md",
                    content_hash=content_hash,
                    status="uploading",
                )
                await state.record_source_uploaded(
                    file_name="001-intro.md",
                    content_hash=content_hash,
                    source_id="src-001-intro",
                    remote_title="C001 Intro",
                )
                await state.record_pending_chunk_studio(
                    file_name="001-intro.md",
                    studio_name="report",
                    content_hash=content_hash,
                    task_id="task-report-1",
                    output_path=str(root / "reports" / "001-intro-report.md"),
                    remote_title=None,
                    error=None,
                    status="pending",
                )

            asyncio.run(scenario())

            payload = json.loads(state_path.read_text(encoding="utf-8"))

        self.assertEqual(payload["version"], 4)
        self.assertEqual(payload["notebook_id"], "nb1")
        self.assertEqual(
            payload["chunks"]["001-intro.md"]["source"]["status"],
            "uploaded",
        )
        self.assertEqual(
            payload["chunks"]["001-intro.md"]["source"]["source_id"],
            "src-001-intro",
        )
        self.assertEqual(
            payload["chunks"]["001-intro.md"]["studios"]["report"]["status"],
            "pending",
        )
        self.assertEqual(
            payload["chunks"]["001-intro.md"]["studios"]["report"]["task_id"],
            "task-report-1",
        )
        self.assertIn("updated_at", payload["chunks"]["001-intro.md"]["source"])
        self.assertIn("attempts", payload["chunks"]["001-intro.md"]["studios"]["report"])

    def test_load_migrates_legacy_quota_block_to_studio_specific_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / ".nblm-run-state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 3,
                        "notebook_id": "nb1",
                        "chunks": {},
                        "notebook_studios": {},
                        "quota_block": {
                            "blocked_until": "2026-03-09T09:00:00Z",
                            "last_error": "quota exceeded",
                            "studio_name": "report",
                            "source_file": "c001-intro.md",
                        },
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            state = RunStateStore.load(state_path)

        self.assertEqual(
            state.quota_block("report"),
            {
                "blocked_until": "2026-03-09T09:00:00Z",
                "last_error": "quota exceeded",
                "source_file": "c001-intro.md",
                "updated_at": None,
            },
        )

    def test_completed_studio_state_does_not_require_downloaded_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunk_path = root / "001-intro.md"
            chunk_path.write_text("# Intro\n\nBody\n", encoding="utf-8")
            content_hash = chunk_content_hash(chunk_path)
            state = RunStateStore(root / ".nblm-run-state.json")

            async def scenario() -> None:
                await state.record_completed_chunk_studio(
                    file_name="001-intro.md",
                    studio_name="report",
                    content_hash=content_hash,
                    artifact_id="art-report-1",
                    output_path=None,
                    remote_title="Report",
                )

            asyncio.run(scenario())

        completed = state.completed_chunk_studio(
            file_name="001-intro.md",
            studio_name="report",
            content_hash=content_hash,
        )
        assert completed is not None
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["output_path"], None)


if __name__ == "__main__":
    unittest.main()
