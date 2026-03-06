from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from notebooklm_chunker.config import StudioConfig, StudiosConfig
from notebooklm_chunker.uploaders.notebooklm_py import (
    NotebookLMPyUploader,
    run_notebooklm_login,
    run_notebooklm_logout,
)


class _FakeNotebook:
    def __init__(self, notebook_id: str) -> None:
        self.id = notebook_id


class _FakeSource:
    def __init__(self, source_id: str) -> None:
        self.id = source_id


class _FakeGenerationStatus:
    def __init__(self, task_id: str, status: str = "completed", error: str | None = None) -> None:
        self.task_id = task_id
        self.status = status
        self.error = error

    @property
    def is_failed(self) -> bool:
        return self.status == "failed"


class _FakeNotebooksAPI:
    def __init__(self, events: list[str]) -> None:
        self.created_titles: list[str] = []
        self.events = events

    async def create(self, title: str) -> _FakeNotebook:
        self.created_titles.append(title)
        self.events.append(f"notebook:{title}")
        return _FakeNotebook("nb1")


class _FakeSourcesAPI:
    delay_seconds = 0.0
    active_uploads = 0
    max_active_uploads = 0

    def __init__(self, events: list[str]) -> None:
        self.calls: list[tuple[str, str, bool]] = []
        self.events = events

    @classmethod
    def reset_state(cls) -> None:
        cls.delay_seconds = 0.0
        cls.active_uploads = 0
        cls.max_active_uploads = 0

    async def add_file(self, notebook_id: str, path: Path, wait: bool = False) -> _FakeSource:
        type(self).active_uploads += 1
        type(self).max_active_uploads = max(type(self).max_active_uploads, type(self).active_uploads)
        try:
            if type(self).delay_seconds:
                await asyncio.sleep(type(self).delay_seconds)
            self.calls.append((notebook_id, path.name, wait))
            self.events.append(f"upload:{path.name}")
            return _FakeSource(f"src-{path.stem}")
        finally:
            type(self).active_uploads -= 1


class _FakeArtifactsAPI:
    def __init__(self, events: list[str]) -> None:
        self.audio_generate_calls: list[dict[str, object]] = []
        self.wait_calls: list[tuple[str, str, float]] = []
        self.audio_download_calls: list[tuple[str, str, str | None]] = []
        self.report_generate_calls: list[dict[str, object]] = []
        self.report_download_calls: list[tuple[str, str, str | None]] = []
        self.slide_generate_calls: list[dict[str, object]] = []
        self.slide_download_calls: list[tuple[str, str, str | None, str]] = []
        self.events = events

    async def generate_audio(
        self,
        notebook_id: str,
        source_ids: list[str] | None = None,
        language: str = "en",
        instructions: str | None = None,
        audio_format=None,
        audio_length=None,
    ) -> _FakeGenerationStatus:
        self.audio_generate_calls.append(
            {
                "notebook_id": notebook_id,
                "source_ids": source_ids,
                "language": language,
                "instructions": instructions,
                "audio_format": audio_format,
                "audio_length": audio_length,
            }
        )
        self.events.append("audio:" + ",".join(source_ids or []))
        return _FakeGenerationStatus("task-audio")

    async def wait_for_completion(
        self,
        notebook_id: str,
        task_id: str,
        timeout: float = 300.0,
    ) -> _FakeGenerationStatus:
        self.wait_calls.append((notebook_id, task_id, timeout))
        return _FakeGenerationStatus(task_id)

    async def download_audio(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
    ) -> str:
        self.audio_download_calls.append((notebook_id, output_path, artifact_id))
        return output_path

    async def generate_report(
        self,
        notebook_id: str,
        report_format=None,
        source_ids: list[str] | None = None,
        language: str = "en",
        custom_prompt: str | None = None,
        extra_instructions: str | None = None,
    ) -> _FakeGenerationStatus:
        self.report_generate_calls.append(
            {
                "notebook_id": notebook_id,
                "report_format": report_format,
                "source_ids": source_ids,
                "language": language,
                "custom_prompt": custom_prompt,
                "extra_instructions": extra_instructions,
            }
        )
        self.events.append("report:" + ",".join(source_ids or []))
        return _FakeGenerationStatus(f"task-report-{len(self.report_generate_calls)}")

    async def download_report(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
    ) -> str:
        self.report_download_calls.append((notebook_id, output_path, artifact_id))
        return output_path

    async def generate_slide_deck(
        self,
        notebook_id: str,
        source_ids: list[str] | None = None,
        language: str = "en",
        instructions: str | None = None,
        slide_format=None,
        slide_length=None,
    ) -> _FakeGenerationStatus:
        self.slide_generate_calls.append(
            {
                "notebook_id": notebook_id,
                "source_ids": source_ids,
                "language": language,
                "instructions": instructions,
                "slide_format": slide_format,
                "slide_length": slide_length,
            }
        )
        self.events.append("slide:" + ",".join(source_ids or []))
        return _FakeGenerationStatus(f"task-slide-{len(self.slide_generate_calls)}")

    async def download_slide_deck(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
        output_format: str = "pdf",
    ) -> str:
        self.slide_download_calls.append((notebook_id, output_path, artifact_id, output_format))
        return output_path


class _FakeClient:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.notebooks = _FakeNotebooksAPI(self.events)
        self.sources = _FakeSourcesAPI(self.events)
        self.artifacts = _FakeArtifactsAPI(self.events)

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None


class _FakeNotebookLMClient:
    last_client: _FakeClient | None = None

    @classmethod
    async def from_storage(cls) -> _FakeClient:
        cls.last_client = _FakeClient()
        return cls.last_client


class _FakeRpcModule:
    AudioFormat = type(
        "AudioFormat",
        (),
        {
            "DEEP_DIVE": "DEEP_DIVE",
            "BRIEF": "BRIEF",
            "CRITIQUE": "CRITIQUE",
            "DEBATE": "DEBATE",
        },
    )
    AudioLength = type(
        "AudioLength",
        (),
        {
            "SHORT": "SHORT",
            "DEFAULT": "DEFAULT",
            "LONG": "LONG",
        },
    )
    ReportFormat = type(
        "ReportFormat",
        (),
        {
            "BRIEFING_DOC": "BRIEFING_DOC",
            "STUDY_GUIDE": "STUDY_GUIDE",
            "BLOG_POST": "BLOG_POST",
            "CUSTOM": "CUSTOM",
        },
    )
    SlideDeckFormat = type(
        "SlideDeckFormat",
        (),
        {
            "DETAILED_DECK": "DETAILED_DECK",
            "PRESENTER_SLIDES": "PRESENTER_SLIDES",
        },
    )
    SlideDeckLength = type(
        "SlideDeckLength",
        (),
        {
            "DEFAULT": "DEFAULT",
            "SHORT": "SHORT",
        },
    )


class UploaderTests(TestCase):
    def setUp(self) -> None:
        _FakeSourcesAPI.reset_state()

    def test_upload_directory_creates_notebook_and_uploads_files(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            chunks_dir = Path(directory)
            (chunks_dir / "001-test.md").write_text("# Title\n\nBody\n", encoding="utf-8")
            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ):
                notebook_id, uploads = uploader.upload_directory(chunks_dir, notebook_title="Notebook")

        self.assertEqual(notebook_id, "nb1")
        self.assertEqual(len(uploads), 1)
        self.assertEqual(_FakeNotebookLMClient.last_client.notebooks.created_titles, ["Notebook"])
        self.assertEqual(
            _FakeNotebookLMClient.last_client.sources.calls,
            [("nb1", "001-test.md", True)],
        )

    def test_upload_directory_respects_max_parallel_chunks(self) -> None:
        uploader = NotebookLMPyUploader()
        _FakeSourcesAPI.delay_seconds = 0.02

        with tempfile.TemporaryDirectory() as directory:
            chunks_dir = Path(directory)
            for index in range(1, 5):
                (chunks_dir / f"{index:03d}-test.md").write_text("# Title\n\nBody\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ):
                _, uploads = uploader.upload_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    max_parallel_chunks=2,
                )

        self.assertEqual(len(uploads), 4)
        self.assertEqual(_FakeSourcesAPI.max_active_uploads, 2)

    def test_upload_directory_prefers_manifest_and_ignores_stale_markdown(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            chunks_dir = Path(directory)
            (chunks_dir / "001-test.md").write_text("# Title\n\nBody\n", encoding="utf-8")
            (chunks_dir / "999-stale.md").write_text("# Stale\n\nBody\n", encoding="utf-8")
            (chunks_dir / "manifest.json").write_text(
                '[{"file":"001-test.md"}]\n',
                encoding="utf-8",
            )
            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ):
                _, uploads = uploader.upload_directory(chunks_dir, notebook_title="Notebook")

        self.assertEqual([Path(item.file_path).name for item in uploads], ["001-test.md"])
        self.assertEqual(
            _FakeNotebookLMClient.last_client.sources.calls,
            [("nb1", "001-test.md", True)],
        )

    def test_ingest_directory_generates_audio_from_uploaded_sources(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            (chunks_dir / "001-intro.md").write_text("# Intro\n\nBody\n", encoding="utf-8")
            (chunks_dir / "002-details.md").write_text("# Details\n\nBody\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                notebook_id, uploads, studio_results = uploader.ingest_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    studios=StudiosConfig(
                        audio=StudioConfig(
                            enabled=True,
                            output_path=str((root / "studio" / "audio-overview.mp4").resolve()),
                        )
                    ),
                )

        self.assertEqual(notebook_id, "nb1")
        self.assertEqual(len(uploads), 2)
        self.assertEqual(len(studio_results), 1)
        self.assertEqual(studio_results[0].studio, "audio")
        self.assertEqual(studio_results[0].artifact_id, "task-audio")
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.audio_generate_calls,
            [
                {
                    "notebook_id": "nb1",
                    "source_ids": ["src-001-intro", "src-002-details"],
                    "language": "en",
                    "instructions": None,
                    "audio_format": "DEEP_DIVE",
                    "audio_length": "LONG",
                }
            ],
        )
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.audio_download_calls,
            [("nb1", str((root / "studio" / "audio-overview.mp4").resolve()), "task-audio")],
        )

    def test_run_login_calls_notebooklm_cli(self) -> None:
        with patch("notebooklm_chunker.uploaders.notebooklm_py.subprocess.run") as mocked:
            run_notebooklm_login()

        mocked.assert_called_once_with(["notebooklm", "login"], check=True)

    def test_run_logout_removes_local_notebooklm_storage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "storage_state.json").write_text("{}", encoding="utf-8")
            (root / "context.json").write_text("{}", encoding="utf-8")
            browser_profile = root / "browser_profile"
            browser_profile.mkdir()
            (browser_profile / "cookies").write_text("data", encoding="utf-8")

            with patch.dict("os.environ", {"NOTEBOOKLM_HOME": str(root)}, clear=False):
                removed_paths, auth_json_note = run_notebooklm_logout()

            self.assertFalse((root / "storage_state.json").exists())
            self.assertFalse((root / "context.json").exists())
            self.assertFalse(browser_profile.exists())
            self.assertEqual(auth_json_note, None)
            self.assertEqual(
                set(removed_paths),
                {
                    str(root / "storage_state.json"),
                    str(root / "context.json"),
                    str(browser_profile),
                },
            )

    def test_ingest_directory_generates_report_and_slide_per_chunk(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            (chunks_dir / "001-intro.md").write_text("# Intro\n\nBody\n", encoding="utf-8")
            (chunks_dir / "002-summary.md").write_text("# Summary\n\nBody\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                _, _, studio_results = uploader.ingest_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    studios=StudiosConfig(
                        report=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            output_dir=str((root / "studio" / "reports").resolve()),
                            format="study-guide",
                        ),
                        slide_deck=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            output_dir=str((root / "studio" / "slides").resolve()),
                            download_format="pdf",
                            format="detailed",
                            length="default",
                        ),
                    ),
                )

        self.assertEqual(len(studio_results), 4)
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.report_generate_calls,
            [
                {
                    "notebook_id": "nb1",
                    "report_format": "STUDY_GUIDE",
                    "source_ids": ["src-001-intro"],
                    "language": "en",
                    "custom_prompt": None,
                    "extra_instructions": None,
                },
                {
                    "notebook_id": "nb1",
                    "report_format": "STUDY_GUIDE",
                    "source_ids": ["src-002-summary"],
                    "language": "en",
                    "custom_prompt": None,
                    "extra_instructions": None,
                },
            ],
        )
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.slide_generate_calls,
            [
                {
                    "notebook_id": "nb1",
                    "source_ids": ["src-001-intro"],
                    "language": "en",
                    "instructions": None,
                    "slide_format": "DETAILED_DECK",
                    "slide_length": "DEFAULT",
                },
                {
                    "notebook_id": "nb1",
                    "source_ids": ["src-002-summary"],
                    "language": "en",
                    "instructions": None,
                    "slide_format": "DETAILED_DECK",
                    "slide_length": "DEFAULT",
                },
            ],
        )
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.report_download_calls,
            [
                (
                    "nb1",
                    str((root / "studio" / "reports" / "001-intro-report.md").resolve()),
                    "task-report-1",
                ),
                (
                    "nb1",
                    str((root / "studio" / "reports" / "002-summary-report.md").resolve()),
                    "task-report-2",
                ),
            ],
        )
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.slide_download_calls,
            [
                (
                    "nb1",
                    str((root / "studio" / "slides" / "001-intro-slide-deck.pdf").resolve()),
                    "task-slide-1",
                    "pdf",
                ),
                (
                    "nb1",
                    str((root / "studio" / "slides" / "002-summary-slide-deck.pdf").resolve()),
                    "task-slide-2",
                    "pdf",
                ),
            ],
        )
        self.assertLess(
            _FakeNotebookLMClient.last_client.events.index("report:src-001-intro"),
            _FakeNotebookLMClient.last_client.events.index("upload:002-summary.md"),
        )
