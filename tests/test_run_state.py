from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from notebooklm_chunker.run_state import RunStateStore, chunk_content_hash


class RunStateStoreTests(unittest.TestCase):
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
                                "remote_title": "001. Intro",
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
        self.assertEqual(uploaded_source, ("src-001-intro", "001. Intro"))
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
                    remote_title="001. Intro",
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

        self.assertEqual(payload["version"], 2)
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


if __name__ == "__main__":
    unittest.main()
