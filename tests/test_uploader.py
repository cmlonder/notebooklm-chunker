from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from notebooklm_chunker.config import StudioConfig, StudiosConfig
from notebooklm_chunker.run_state import chunk_content_hash
from notebooklm_chunker.uploaders.notebooklm_py import (
    CreateQuotaCooldown,
    NotebookLMPyUploader,
    UploadError,
    _create_artifact_with_retry,
    run_notebooklm_login,
    run_notebooklm_logout,
)


class _FakeNotebook:
    def __init__(self, notebook_id: str, title: str | None = None) -> None:
        self.id = notebook_id
        self.title = title


class _FakeSource:
    def __init__(self, source_id: str) -> None:
        self.id = source_id


class _FakeArtifact:
    def __init__(self, artifact_id: str, kind: str, title: str) -> None:
        self.id = artifact_id
        self.kind = kind
        self.title = title


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
        self._titles_by_id: dict[str, str] = {}

    async def create(self, title: str) -> _FakeNotebook:
        self.created_titles.append(title)
        self.events.append(f"notebook:{title}")
        self._titles_by_id["nb1"] = title
        return _FakeNotebook("nb1", title)

    async def get(self, notebook_id: str) -> _FakeNotebook:
        self.events.append(f"notebook-get:{notebook_id}")
        return _FakeNotebook(notebook_id, self._titles_by_id.get(notebook_id, "Existing Notebook"))

    async def list(self) -> list[_FakeNotebook]:
        return [_FakeNotebook(notebook_id, title) for notebook_id, title in self._titles_by_id.items()]


class _FakeSourcesAPI:
    delay_seconds = 0.0
    active_uploads = 0
    max_active_uploads = 0

    def __init__(self, events: list[str]) -> None:
        self.calls: list[tuple[str, str, bool]] = []
        self.rename_calls: list[tuple[str, str, str]] = []
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

    async def rename(self, notebook_id: str, source_id: str, new_title: str) -> None:
        self.rename_calls.append((notebook_id, source_id, new_title))
        self.events.append(f"source-rename:{source_id}:{new_title}")


class _FakeArtifactsAPI:
    def __init__(self, events: list[str]) -> None:
        self.audio_generate_calls: list[dict[str, object]] = []
        self.wait_calls: list[tuple[str, str, float]] = []
        self.audio_download_calls: list[tuple[str, str, str | None]] = []
        self.report_generate_calls: list[dict[str, object]] = []
        self.report_download_calls: list[tuple[str, str, str | None]] = []
        self.slide_generate_calls: list[dict[str, object]] = []
        self.slide_download_calls: list[tuple[str, str, str | None, str]] = []
        self.quiz_generate_calls: list[dict[str, object]] = []
        self.quiz_download_calls: list[tuple[str, str, str | None, str]] = []
        self.rename_calls: list[tuple[str, str, str]] = []
        self._artifacts: list[_FakeArtifact] = []
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
        artifact_id = f"art-audio-{len(self.audio_generate_calls) + 1}"
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
        self._artifacts.append(_FakeArtifact(artifact_id, "audio", f"Audio {len(self.audio_generate_calls)}"))
        self.events.append("audio:" + ",".join(source_ids or []))
        return _FakeGenerationStatus(artifact_id)

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
        artifact_id = f"art-report-{len(self.report_generate_calls) + 1}"
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
        self._artifacts.append(_FakeArtifact(artifact_id, "report", f"Report {len(self.report_generate_calls)}"))
        self.events.append("report:" + ",".join(source_ids or []))
        return _FakeGenerationStatus(artifact_id)

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
        artifact_id = f"art-slide-deck-{len(self.slide_generate_calls) + 1}"
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
        self._artifacts.append(
            _FakeArtifact(artifact_id, "slide_deck", f"Slide Deck {len(self.slide_generate_calls)}")
        )
        self.events.append("slide:" + ",".join(source_ids or []))
        return _FakeGenerationStatus(artifact_id)

    async def download_slide_deck(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
        output_format: str = "pdf",
    ) -> str:
        self.slide_download_calls.append((notebook_id, output_path, artifact_id, output_format))
        return output_path

    async def generate_quiz(
        self,
        notebook_id: str,
        source_ids: list[str] | None = None,
        instructions: str | None = None,
        quantity=None,
        difficulty=None,
    ) -> _FakeGenerationStatus:
        artifact_id = f"art-quiz-{len(self.quiz_generate_calls) + 1}"
        self.quiz_generate_calls.append(
            {
                "notebook_id": notebook_id,
                "source_ids": source_ids,
                "instructions": instructions,
                "quantity": quantity,
                "difficulty": difficulty,
            }
        )
        self._artifacts.append(_FakeArtifact(artifact_id, "quiz", f"Quiz {len(self.quiz_generate_calls)}"))
        self.events.append("quiz:" + ",".join(source_ids or []))
        return _FakeGenerationStatus(artifact_id)

    async def download_quiz(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
        output_format: str = "json",
    ) -> str:
        self.quiz_download_calls.append((notebook_id, output_path, artifact_id, output_format))
        return output_path

    async def list(self, notebook_id: str) -> list[_FakeArtifact]:
        return list(self._artifacts)

    async def rename(self, notebook_id: str, artifact_id: str, new_title: str) -> None:
        self.rename_calls.append((notebook_id, artifact_id, new_title))
        self.events.append(f"artifact-rename:{artifact_id}:{new_title}")
        for artifact in self._artifacts:
            if artifact.id == artifact_id:
                artifact.title = new_title
                return
        raise AssertionError(f"Unknown artifact id: {artifact_id}")


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
    QuizQuantity = type(
        "QuizQuantity",
        (),
        {
            "FEWER": "FEWER",
            "STANDARD": "STANDARD",
            "MORE": "MORE",
        },
    )
    QuizDifficulty = type(
        "QuizDifficulty",
        (),
        {
            "EASY": "EASY",
            "MEDIUM": "MEDIUM",
            "HARD": "HARD",
        },
    )


class UploaderTests(TestCase):
    def setUp(self) -> None:
        _FakeSourcesAPI.reset_state()

    def test_upload_directory_creates_notebook_and_uploads_files(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            chunks_dir = Path(directory)
            (chunks_dir / "c001-test.md").write_text("# Title\n\nBody\n", encoding="utf-8")
            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ):
                notebook_id, uploads = uploader.upload_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    rename_remote_titles=True,
                )

        self.assertEqual(notebook_id, "nb1")
        self.assertEqual(len(uploads), 1)
        self.assertEqual(_FakeNotebookLMClient.last_client.notebooks.created_titles, ["Notebook"])
        self.assertEqual(
            _FakeNotebookLMClient.last_client.sources.calls,
            [("nb1", "c001-test.md", True)],
        )
        self.assertEqual(
            _FakeNotebookLMClient.last_client.sources.rename_calls,
            [("nb1", "src-c001-test", "C001 Title")],
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
                    rename_remote_titles=True,
                )

        self.assertEqual(len(uploads), 4)
        self.assertEqual(_FakeSourcesAPI.max_active_uploads, 2)

    def test_upload_directory_prefers_first_section_heading_for_remote_title(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            chunks_dir = Path(directory)
            (chunks_dir / "c001-test.md").write_text("# Book\n\n## Origins\n\nBody\n", encoding="utf-8")
            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ):
                uploader.upload_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    rename_remote_titles=True,
                )

        self.assertEqual(
            _FakeNotebookLMClient.last_client.sources.rename_calls,
            [("nb1", "src-c001-test", "C001 Origins")],
        )

    def test_upload_directory_does_not_rename_remote_titles_by_default(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            chunks_dir = Path(directory)
            (chunks_dir / "c001-test.md").write_text("# Title\n\nBody\n", encoding="utf-8")
            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ):
                _, uploads = uploader.upload_directory(chunks_dir, notebook_title="Notebook")

        self.assertEqual(len(uploads), 1)
        self.assertEqual(_FakeNotebookLMClient.last_client.sources.rename_calls, [])

    def test_run_studios_passes_long_wait_timeout(self) -> None:
        uploader = NotebookLMPyUploader()

        with patch(
            "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
            return_value=_FakeNotebookLMClient,
        ), patch(
            "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
            return_value=_FakeRpcModule,
        ):
            results = uploader.run_studios(
                notebook_id="nb1",
                studios=StudiosConfig(
                    audio=StudioConfig(
                        enabled=True,
                        output_path="/tmp/audio-overview.mp4",
                    )
                ),
                studio_wait_timeout_seconds=7200.0,
            )

        self.assertEqual(len(results), 1)
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.wait_calls,
            [("nb1", "art-audio-1", 7200.0)],
        )

    def test_run_studios_can_generate_per_chunk_quiz_from_saved_run_state(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            intro_path = chunks_dir / "c001-intro.md"
            summary_path = chunks_dir / "c002-summary.md"
            intro_path.write_text("# Intro\n\nBody\n", encoding="utf-8")
            summary_path.write_text("# Summary\n\nBody\n", encoding="utf-8")
            state_payload = {
                "version": 2,
                "notebook_id": "nb1",
                "notebook_title": "Notebook",
                "chunks": {
                    "c001-intro.md": {
                        "content_hash": chunk_content_hash(intro_path),
                        "source": {
                            "status": "uploaded",
                            "source_id": "src-c001-intro",
                            "remote_title": "C001 Intro",
                        },
                        "studios": {},
                    },
                    "c002-summary.md": {
                        "content_hash": chunk_content_hash(summary_path),
                        "source": {
                            "status": "uploaded",
                            "source_id": "src-c002-summary",
                            "remote_title": "C002 Summary",
                        },
                        "studios": {},
                    },
                },
                "notebook_studios": {},
            }
            state_path = chunks_dir / ".nblm-run-state.json"
            state_path.write_text(json.dumps(state_payload, indent=2) + "\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                results = uploader.run_studios(
                    notebook_id=None,
                    run_state_path=state_path,
                    studios=StudiosConfig(
                        quiz=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            output_dir=str((root / "studio" / "quizzes").resolve()),
                            quantity="more",
                            difficulty="hard",
                            download_format="json",
                        )
                    ),
                )

        self.assertEqual(len(results), 2)
        self.assertEqual(_FakeNotebookLMClient.last_client.sources.calls, [])
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.quiz_generate_calls,
            [
                {
                    "notebook_id": "nb1",
                    "source_ids": ["src-c001-intro"],
                    "instructions": None,
                    "quantity": "MORE",
                    "difficulty": "HARD",
                },
                {
                    "notebook_id": "nb1",
                    "source_ids": ["src-c002-summary"],
                    "instructions": None,
                    "quantity": "MORE",
                    "difficulty": "HARD",
                },
            ],
        )
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.quiz_download_calls,
            [
                (
                    "nb1",
                    str((root / "studio" / "quizzes" / "c001-intro-quiz.json").resolve()),
                    "art-quiz-1",
                    "json",
                ),
                (
                    "nb1",
                    str((root / "studio" / "quizzes" / "c002-summary-quiz.json").resolve()),
                    "art-quiz-2",
                    "json",
                ),
            ],
        )

    def test_run_studios_can_complete_without_downloading_outputs(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            intro_path = chunks_dir / "c001-intro.md"
            intro_path.write_text("# Intro\n\nBody\n", encoding="utf-8")
            state_payload = {
                "version": 4,
                "notebook_id": "nb1",
                "notebook_title": "Notebook",
                "chunks": {
                    "c001-intro.md": {
                        "content_hash": chunk_content_hash(intro_path),
                        "source": {
                            "status": "uploaded",
                            "source_id": "src-c001-intro",
                            "remote_title": "C001 Intro",
                        },
                        "studios": {},
                    },
                },
                "notebook_studios": {},
                "quota_blocks": {},
            }
            state_path = chunks_dir / ".nblm-run-state.json"
            state_path.write_text(json.dumps(state_payload, indent=2) + "\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                results = uploader.run_studios(
                    notebook_id=None,
                    run_state_path=state_path,
                    studios=StudiosConfig(
                        quiz=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            output_dir=str((root / "studio" / "quizzes").resolve()),
                            quantity="more",
                            difficulty="hard",
                            download_format="json",
                        )
                    ),
                    download_outputs=False,
                )

            saved_state = json.loads(state_path.read_text(encoding="utf-8"))

        self.assertEqual(len(results), 1)
        self.assertIsNone(results[0].output_path)
        self.assertEqual(_FakeNotebookLMClient.last_client.artifacts.quiz_download_calls, [])
        self.assertEqual(
            saved_state["chunks"]["c001-intro.md"]["studios"]["quiz"]["status"],
            "completed",
        )
        self.assertIsNone(saved_state["chunks"]["c001-intro.md"]["studios"]["quiz"]["output_path"])

    def test_completed_studio_without_download_is_reused_on_resume(self) -> None:
        uploader = NotebookLMPyUploader()

        class _NoCreateQuizArtifacts(_FakeArtifactsAPI):
            async def generate_quiz(self, *args, **kwargs):  # type: ignore[override]
                raise AssertionError("completed quiz should not be generated again")

        class _NoCreateQuizClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.artifacts = _NoCreateQuizArtifacts(self.events)

        class _NoCreateQuizNotebookLMClient:
            last_client: _NoCreateQuizClient | None = None

            @classmethod
            async def from_storage(cls):
                cls.last_client = _NoCreateQuizClient()
                return cls.last_client

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            intro_path = chunks_dir / "c001-intro.md"
            intro_path.write_text("# Intro\n\nBody\n", encoding="utf-8")
            state_payload = {
                "version": 4,
                "notebook_id": "nb1",
                "notebook_title": "Notebook",
                "chunks": {
                    "c001-intro.md": {
                        "content_hash": chunk_content_hash(intro_path),
                        "source": {
                            "status": "uploaded",
                            "source_id": "src-c001-intro",
                            "remote_title": "C001 Intro",
                        },
                        "studios": {
                            "quiz": {
                                "status": "completed",
                                "task_id": None,
                                "artifact_id": "art-quiz-1",
                                "output_path": None,
                                "remote_title": None,
                                "attempts": 1,
                                "last_error": None,
                                "next_retry_at": None,
                                "updated_at": "2026-03-08T00:00:00Z",
                            }
                        },
                    },
                },
                "notebook_studios": {},
                "quota_blocks": {},
            }
            state_path = chunks_dir / ".nblm-run-state.json"
            state_path.write_text(json.dumps(state_payload, indent=2) + "\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_NoCreateQuizNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                results = uploader.run_studios(
                    notebook_id=None,
                    run_state_path=state_path,
                    studios=StudiosConfig(
                        quiz=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            output_dir=str((root / "studio" / "quizzes").resolve()),
                            quantity="more",
                            difficulty="hard",
                            download_format="json",
                        )
                    ),
                    download_outputs=False,
                )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].status, "completed")
        self.assertIsNone(results[0].output_path)
        self.assertEqual(_NoCreateQuizNotebookLMClient.last_client.artifacts.quiz_generate_calls, [])

    def test_slide_deck_create_failure_is_saved_for_resume(self) -> None:
        uploader = NotebookLMPyUploader()

        class _NoTaskArtifacts(_FakeArtifactsAPI):
            async def generate_slide_deck(self, *args, **kwargs):  # type: ignore[override]
                return _FakeGenerationStatus("", status="failed", error="upstream create failed")

        class _NoTaskClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.artifacts = _NoTaskArtifacts(self.events)

        class _NoTaskNotebookLMClient:
            @classmethod
            async def from_storage(cls):
                return _NoTaskClient()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            (chunks_dir / "001-intro.md").write_text("# Intro\n\nBody\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_NoTaskNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                notebook_id, uploads, studio_results = uploader.ingest_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    studios=StudiosConfig(
                        slide_deck=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            output_dir=str((root / "studio" / "slides").resolve()),
                            download_format="pdf",
                            format="detailed",
                            length="default",
                        ),
                    ),
                    studio_create_retries=0,
                    studio_create_backoff_seconds=0.01,
                )

            state = json.loads((chunks_dir / ".nblm-run-state.json").read_text(encoding="utf-8"))

        self.assertEqual(notebook_id, "nb1")
        self.assertEqual(len(uploads), 1)
        self.assertEqual(len(studio_results), 1)
        self.assertEqual(studio_results[0].status, "pending")
        self.assertEqual(state["version"], 4)
        self.assertEqual(
            state["chunks"]["001-intro.md"]["studios"]["slide_deck"]["status"],
            "create_failed",
        )
        self.assertIn(
            "slide-deck [001-intro.md] create failed before a task ID was returned",
            state["chunks"]["001-intro.md"]["studios"]["slide_deck"]["last_error"],
        )

    def test_ingest_directory_blocks_only_exhausted_studio_type_and_preserves_other_results(self) -> None:
        uploader = NotebookLMPyUploader()

        class _QuotaArtifacts(_FakeArtifactsAPI):
            async def generate_report(self, *args, **kwargs):  # type: ignore[override]
                return _FakeGenerationStatus("", status="failed", error="API rate limit or quota exceeded. Please wait before retrying.")

        class _QuotaClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.artifacts = _QuotaArtifacts(self.events)

        class _QuotaNotebookLMClient:
            last_client: _QuotaClient | None = None

            @classmethod
            async def from_storage(cls):
                cls.last_client = _QuotaClient()
                return cls.last_client

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            (chunks_dir / "001-intro.md").write_text("# Intro\n\nBody\n", encoding="utf-8")
            progress: list[str] = []

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_QuotaNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                with self.assertRaises(UploadError) as context:
                    uploader.ingest_directory(
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
                        studio_create_retries=5,
                        studio_create_backoff_seconds=0.01,
                        reporter=progress.append,
                    )

            state = json.loads((chunks_dir / ".nblm-run-state.json").read_text(encoding="utf-8"))

        self.assertIn("Daily NotebookLM quota appears exhausted for: report until", str(context.exception))
        self.assertIsNotNone(state["quota_blocks"]["report"]["blocked_until"])
        self.assertEqual(state["chunks"]["001-intro.md"]["studios"]["report"]["status"], "quota_blocked")
        self.assertEqual(state["chunks"]["001-intro.md"]["studios"]["slide_deck"]["status"], "completed")
        self.assertEqual(
            state["chunks"]["001-intro.md"]["studios"]["report"]["next_retry_at"],
            state["quota_blocks"]["report"]["blocked_until"],
        )
        self.assertNotIn("slide_deck", state["quota_blocks"])
        self.assertEqual(
            _QuotaNotebookLMClient.last_client.artifacts.slide_download_calls,
            [
                (
                    "nb1",
                    str((root / "studio" / "slides" / "001-intro-slide-deck.pdf").resolve()),
                    "art-slide-deck-1",
                    "pdf",
                ),
            ],
        )
        self.assertTrue(
            any(
                "studio: quota exhausted report [001-intro.md] ->" in line
                or "studio: suspending remaining report jobs until" in line
                for line in progress
            )
        )

    def test_ingest_directory_logs_create_failure_details(self) -> None:
        uploader = NotebookLMPyUploader()

        class _NoTaskArtifacts(_FakeArtifactsAPI):
            async def generate_slide_deck(self, *args, **kwargs):  # type: ignore[override]
                return _FakeGenerationStatus("", status="failed", error="upstream create failed")

        class _NoTaskClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.artifacts = _NoTaskArtifacts(self.events)

        class _NoTaskNotebookLMClient:
            @classmethod
            async def from_storage(cls):
                return _NoTaskClient()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            (chunks_dir / "001-intro.md").write_text("# Intro\n\nBody\n", encoding="utf-8")
            progress: list[str] = []

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_NoTaskNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                uploader.ingest_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    studios=StudiosConfig(
                        slide_deck=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            output_dir=str((root / "studio" / "slides").resolve()),
                            download_format="pdf",
                            format="detailed",
                            length="default",
                        ),
                    ),
                    studio_create_retries=0,
                    studio_create_backoff_seconds=0.01,
                    reporter=progress.append,
                )

        self.assertTrue(
            any(
                "studio: create failure slide-deck [001-intro.md] attempt 1/1:" in line
                and "status=failed, error=upstream create failed" in line
                for line in progress
            )
        )

    def test_ingest_directory_fails_fast_when_resume_notebook_is_missing(self) -> None:
        uploader = NotebookLMPyUploader()

        class _MissingNotebookNotebooksAPI(_FakeNotebooksAPI):
            async def get(self, notebook_id: str) -> _FakeNotebook:  # type: ignore[override]
                raise ValueError(f"Notebook not found: {notebook_id}")

        class _MissingNotebookClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.notebooks = _MissingNotebookNotebooksAPI(self.events)

        class _MissingNotebookLMClient:
            @classmethod
            async def from_storage(cls):
                return _MissingNotebookClient()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            chunk_path = chunks_dir / "001-intro.md"
            chunk_path.write_text("# Intro\n\nBody\n", encoding="utf-8")
            state_payload = {
                "version": 1,
                "notebook_id": "nb-missing",
                "notebook_title": "Notebook",
                "chunks": {
                    "001-intro.md": {
                        "content_hash": chunk_content_hash(chunk_path),
                        "source_id": "src-001-intro",
                        "studios": {},
                    }
                },
                "notebook_studios": {},
            }
            (chunks_dir / ".nblm-run-state.json").write_text(
                json.dumps(state_payload, indent=2) + "\n",
                encoding="utf-8",
            )

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_MissingNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                with self.assertRaises(UploadError) as context:
                    uploader.ingest_directory(
                        chunks_dir,
                        notebook_title="Notebook",
                        studios=StudiosConfig(),
                        resume=True,
                    )

        self.assertIn('Notebook "nb-missing" is not available', str(context.exception))
        self.assertIn(".nblm-run-state.json", str(context.exception))

    def test_ingest_directory_resume_requires_existing_state_file(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            (chunks_dir / "001-intro.md").write_text("# Intro\n\nBody\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                with self.assertRaises(UploadError) as context:
                    uploader.ingest_directory(
                        chunks_dir,
                        notebook_title="Notebook",
                        studios=StudiosConfig(),
                        resume=True,
                    )

        self.assertIn("No resume state found", str(context.exception))
        self.assertIn("nblm run", str(context.exception))

    def test_ingest_directory_default_run_ignores_existing_resume_state(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            chunk_path = chunks_dir / "001-intro.md"
            chunk_path.write_text("# Intro\n\nBody\n", encoding="utf-8")
            state_payload = {
                "version": 1,
                "notebook_id": "nb-old",
                "notebook_title": "Old Notebook",
                "chunks": {
                    "001-intro.md": {
                        "content_hash": chunk_content_hash(chunk_path),
                        "source_id": "src-old",
                        "studios": {},
                    }
                },
                "notebook_studios": {},
            }
            (chunks_dir / ".nblm-run-state.json").write_text(
                json.dumps(state_payload, indent=2) + "\n",
                encoding="utf-8",
            )

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
                    studios=StudiosConfig(),
                )

            state = json.loads((chunks_dir / ".nblm-run-state.json").read_text(encoding="utf-8"))

        self.assertEqual(notebook_id, "nb1")
        self.assertEqual(len(uploads), 1)
        self.assertEqual(studio_results, [])
        self.assertEqual(_FakeNotebookLMClient.last_client.notebooks.created_titles, ["Notebook"])
        self.assertEqual(_FakeNotebookLMClient.last_client.sources.calls, [("nb1", "001-intro.md", True)])
        self.assertEqual(state["notebook_id"], "nb1")

    def test_ingest_directory_retries_create_artifact_failures_with_backoff(self) -> None:
        uploader = NotebookLMPyUploader()

        class _RetrySlideArtifacts(_FakeArtifactsAPI):
            def __init__(self, events: list[str]) -> None:
                super().__init__(events)
                self.slide_attempts = 0

            async def generate_slide_deck(self, *args, **kwargs):  # type: ignore[override]
                self.slide_attempts += 1
                if self.slide_attempts == 1:
                    return _FakeGenerationStatus("", status="failed", error="temporary create failure")
                return await super().generate_slide_deck(*args, **kwargs)

        class _RetrySlideClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.artifacts = _RetrySlideArtifacts(self.events)

        class _RetrySlideNotebookLMClient:
            last_client: _RetrySlideClient | None = None

            @classmethod
            async def from_storage(cls):
                cls.last_client = _RetrySlideClient()
                return cls.last_client

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            (chunks_dir / "001-intro.md").write_text("# Intro\n\nBody\n", encoding="utf-8")
            progress: list[str] = []

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_RetrySlideNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                _, _, studio_results = uploader.ingest_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    studios=StudiosConfig(
                        slide_deck=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            output_dir=str((root / "studio" / "slides").resolve()),
                            download_format="pdf",
                            format="detailed",
                            length="default",
                        ),
                    ),
                    studio_create_retries=2,
                    studio_create_backoff_seconds=0.01,
                    reporter=progress.append,
                )

        self.assertEqual(len(studio_results), 1)
        self.assertEqual(_RetrySlideNotebookLMClient.last_client.artifacts.slide_attempts, 2)
        self.assertTrue(any("retry 1/2 slide-deck [001-intro.md] create after failure" in line for line in progress))

    def test_upload_directory_prefers_manifest_and_ignores_stale_markdown(self) -> None:
        uploader = NotebookLMPyUploader()

        with tempfile.TemporaryDirectory() as directory:
            chunks_dir = Path(directory)
            (chunks_dir / "c001-test.md").write_text("# Title\n\nBody\n", encoding="utf-8")
            (chunks_dir / "999-stale.md").write_text("# Stale\n\nBody\n", encoding="utf-8")
            (chunks_dir / "manifest.json").write_text(
                '[{"file":"c001-test.md"}]\n',
                encoding="utf-8",
            )
            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_FakeNotebookLMClient,
            ):
                _, uploads = uploader.upload_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    rename_remote_titles=True,
                )

        self.assertEqual([Path(item.file_path).name for item in uploads], ["c001-test.md"])
        self.assertEqual(
            _FakeNotebookLMClient.last_client.sources.calls,
            [("nb1", "c001-test.md", True)],
        )
        self.assertEqual(
            _FakeNotebookLMClient.last_client.sources.rename_calls,
            [("nb1", "src-c001-test", "C001 Title")],
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
                    rename_remote_titles=True,
                )

        self.assertEqual(notebook_id, "nb1")
        self.assertEqual(len(uploads), 2)
        self.assertEqual(len(studio_results), 1)
        self.assertEqual(studio_results[0].studio, "audio")
        self.assertEqual(studio_results[0].artifact_id, "art-audio-1")
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
            [("nb1", str((root / "studio" / "audio-overview.mp4").resolve()), "art-audio-1")],
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
            (chunks_dir / "c001-intro.md").write_text("# Intro\n\nBody\n", encoding="utf-8")
            (chunks_dir / "c002-summary.md").write_text("# Summary\n\nBody\n", encoding="utf-8")

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
                    rename_remote_titles=True,
                )

        self.assertEqual(len(studio_results), 4)
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.report_generate_calls,
            [
                {
                    "notebook_id": "nb1",
                    "report_format": "STUDY_GUIDE",
                    "source_ids": ["src-c001-intro"],
                    "language": "en",
                    "custom_prompt": None,
                    "extra_instructions": None,
                },
                {
                    "notebook_id": "nb1",
                    "report_format": "STUDY_GUIDE",
                    "source_ids": ["src-c002-summary"],
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
                    "source_ids": ["src-c001-intro"],
                    "language": "en",
                    "instructions": None,
                    "slide_format": "DETAILED_DECK",
                    "slide_length": "DEFAULT",
                },
                {
                    "notebook_id": "nb1",
                    "source_ids": ["src-c002-summary"],
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
                    str((root / "studio" / "reports" / "c001-intro-report.md").resolve()),
                    "art-report-1",
                ),
                (
                    "nb1",
                    str((root / "studio" / "reports" / "c002-summary-report.md").resolve()),
                    "art-report-2",
                ),
            ],
        )
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.slide_download_calls,
            [
                (
                    "nb1",
                    str((root / "studio" / "slides" / "c001-intro-slide-deck.pdf").resolve()),
                    "art-slide-deck-1",
                    "pdf",
                ),
                (
                    "nb1",
                    str((root / "studio" / "slides" / "c002-summary-slide-deck.pdf").resolve()),
                    "art-slide-deck-2",
                    "pdf",
                ),
            ],
        )
        self.assertEqual(
            _FakeNotebookLMClient.last_client.sources.rename_calls,
            [
                ("nb1", "src-c001-intro", "C001 Intro"),
                ("nb1", "src-c002-summary", "C002 Summary"),
            ],
        )
        self.assertEqual(
            _FakeNotebookLMClient.last_client.artifacts.rename_calls,
            [
                ("nb1", "art-report-1", "C001 Intro - Report"),
                ("nb1", "art-report-2", "C002 Summary - Report"),
                ("nb1", "art-slide-deck-1", "C001 Intro - Slide Deck"),
                ("nb1", "art-slide-deck-2", "C002 Summary - Slide Deck"),
            ],
        )
        self.assertLess(
            _FakeNotebookLMClient.last_client.events.index("report:src-c001-intro"),
            _FakeNotebookLMClient.last_client.events.index("slide:src-c001-intro"),
        )

    def test_ingest_directory_throttles_heavy_studios_separately_from_chunk_parallelism(self) -> None:
        uploader = NotebookLMPyUploader()

        class _ThrottledSlideArtifacts(_FakeArtifactsAPI):
            active_slide_jobs = 0
            max_active_slide_jobs = 0

            @classmethod
            def reset_state(cls) -> None:
                cls.active_slide_jobs = 0
                cls.max_active_slide_jobs = 0

            async def generate_slide_deck(self, *args, **kwargs):  # type: ignore[override]
                type(self).active_slide_jobs += 1
                type(self).max_active_slide_jobs = max(
                    type(self).max_active_slide_jobs,
                    type(self).active_slide_jobs,
                )
                try:
                    await asyncio.sleep(0.02)
                    return await super().generate_slide_deck(*args, **kwargs)
                finally:
                    type(self).active_slide_jobs -= 1

        class _ThrottledSlideClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.artifacts = _ThrottledSlideArtifacts(self.events)

        class _ThrottledSlideNotebookLMClient:
            last_client: _ThrottledSlideClient | None = None

            @classmethod
            async def from_storage(cls):
                cls.last_client = _ThrottledSlideClient()
                return cls.last_client

        _ThrottledSlideArtifacts.reset_state()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            (chunks_dir / "001-intro.md").write_text("# Intro\n\nBody\n", encoding="utf-8")
            (chunks_dir / "002-summary.md").write_text("# Summary\n\nBody\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_ThrottledSlideNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                _, _, studio_results = uploader.ingest_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    studios=StudiosConfig(
                        slide_deck=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            output_dir=str((root / "studio" / "slides").resolve()),
                            download_format="pdf",
                            format="detailed",
                            length="default",
                        ),
                    ),
                    max_parallel_chunks=2,
                    max_parallel_heavy_studios=1,
                )

        self.assertEqual(len(studio_results), 2)
        self.assertEqual(_ThrottledSlideArtifacts.max_active_slide_jobs, 1)

    def test_ingest_directory_uses_per_studio_parallel_override_for_slide_deck(self) -> None:
        uploader = NotebookLMPyUploader()

        class _OverriddenSlideArtifacts(_FakeArtifactsAPI):
            active_slide_jobs = 0
            max_active_slide_jobs = 0

            @classmethod
            def reset_state(cls) -> None:
                cls.active_slide_jobs = 0
                cls.max_active_slide_jobs = 0

            async def generate_slide_deck(self, *args, **kwargs):  # type: ignore[override]
                type(self).active_slide_jobs += 1
                type(self).max_active_slide_jobs = max(
                    type(self).max_active_slide_jobs,
                    type(self).active_slide_jobs,
                )
                try:
                    await asyncio.sleep(0.02)
                    return await super().generate_slide_deck(*args, **kwargs)
                finally:
                    type(self).active_slide_jobs -= 1

        class _OverriddenSlideClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.artifacts = _OverriddenSlideArtifacts(self.events)

        class _OverriddenSlideNotebookLMClient:
            last_client: _OverriddenSlideClient | None = None

            @classmethod
            async def from_storage(cls):
                cls.last_client = _OverriddenSlideClient()
                return cls.last_client

        _OverriddenSlideArtifacts.reset_state()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            for index in range(1, 6):
                (chunks_dir / f"{index:03d}-slide.md").write_text("# Slide\n\nBody\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_OverriddenSlideNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                _, _, studio_results = uploader.ingest_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    studios=StudiosConfig(
                        slide_deck=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            max_parallel=4,
                            output_dir=str((root / "studio" / "slides").resolve()),
                            download_format="pdf",
                            format="detailed",
                            length="default",
                        ),
                    ),
                    max_parallel_chunks=5,
                    max_parallel_heavy_studios=1,
                )

        self.assertEqual(len(studio_results), 5)
        self.assertEqual(_OverriddenSlideArtifacts.max_active_slide_jobs, 4)

    def test_create_artifact_retry_applies_shared_quota_cooldown(self) -> None:
        async def run_scenario() -> tuple[list[str], float]:
            progress: list[str] = []
            cooldown = CreateQuotaCooldown(0.02)
            first_attempt_at: float | None = None
            second_attempt_at: float | None = None

            async def create_operation():
                nonlocal first_attempt_at, second_attempt_at
                loop = asyncio.get_running_loop()
                if first_attempt_at is None:
                    first_attempt_at = loop.time()
                    return _FakeGenerationStatus("", status="failed", error="API rate limit or too many requests.")
                second_attempt_at = loop.time()
                return _FakeGenerationStatus("task-1")

            await _create_artifact_with_retry(
                studio_label="report [001-test.md]",
                create_operation=create_operation,
                studio_name="report",
                retry_count=1,
                backoff_seconds=0.01,
                quota_cooldown=cooldown,
                studio_quota_blocks={},
                reporter=progress.append,
            )
            assert first_attempt_at is not None
            assert second_attempt_at is not None
            return progress, second_attempt_at - first_attempt_at

        progress, elapsed = asyncio.run(run_scenario())

        self.assertGreaterEqual(elapsed, 0.02)
        self.assertTrue(any("quota cooldown triggered" in line for line in progress))
        self.assertTrue(any("quota cooldown delayed" in line for line in progress))

    def test_ingest_directory_continues_uploading_while_reports_run(self) -> None:
        uploader = NotebookLMPyUploader()
        _FakeSourcesAPI.delay_seconds = 0.01

        class _SlowReportArtifacts(_FakeArtifactsAPI):
            async def generate_report(self, *args, **kwargs):  # type: ignore[override]
                await asyncio.sleep(0.05)
                return await super().generate_report(*args, **kwargs)

        class _SlowReportClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.artifacts = _SlowReportArtifacts(self.events)

        class _SlowReportNotebookLMClient:
            last_client: _SlowReportClient | None = None

            @classmethod
            async def from_storage(cls):
                cls.last_client = _SlowReportClient()
                return cls.last_client

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            for index in range(1, 5):
                (chunks_dir / f"{index:03d}-chapter.md").write_text("# Chapter\n\nBody\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_SlowReportNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                _, uploads, studio_results = uploader.ingest_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    studios=StudiosConfig(
                        report=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            output_dir=str((root / "studio" / "reports").resolve()),
                            format="study-guide",
                        ),
                    ),
                    max_parallel_chunks=2,
                )

        self.assertEqual(len(uploads), 4)
        self.assertEqual(len(studio_results), 4)
        events = _SlowReportNotebookLMClient.last_client.events
        self.assertLess(
            events.index("upload:003-chapter.md"),
            events.index("report:src-001-chapter"),
        )

    def test_ingest_directory_continues_uploading_while_heavy_studio_retries(self) -> None:
        uploader = NotebookLMPyUploader()
        _FakeSourcesAPI.delay_seconds = 0.01

        class _SlowSlideArtifacts(_FakeArtifactsAPI):
            async def generate_slide_deck(self, *args, **kwargs):  # type: ignore[override]
                await asyncio.sleep(0.05)
                return await super().generate_slide_deck(*args, **kwargs)

        class _SlowSlideClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.artifacts = _SlowSlideArtifacts(self.events)

        class _SlowSlideNotebookLMClient:
            last_client: _SlowSlideClient | None = None

            @classmethod
            async def from_storage(cls):
                cls.last_client = _SlowSlideClient()
                return cls.last_client

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            for index in range(1, 5):
                (chunks_dir / f"{index:03d}-chapter.md").write_text("# Chapter\n\nBody\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_SlowSlideNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                _, uploads, studio_results = uploader.ingest_directory(
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
                    max_parallel_chunks=2,
                    max_parallel_heavy_studios=1,
                )

        self.assertEqual(len(uploads), 4)
        self.assertEqual(len(studio_results), 8)
        events = _SlowSlideNotebookLMClient.last_client.events
        self.assertLess(
            events.index("upload:003-chapter.md"),
            events.index("slide:src-001-chapter"),
        )

    def test_ingest_directory_marks_slide_deck_pending_on_wait_timeout(self) -> None:
        uploader = NotebookLMPyUploader()

        class _TimeoutSlideArtifacts(_FakeArtifactsAPI):
            async def wait_for_completion(self, notebook_id: str, task_id: str, timeout: float = 300.0):  # type: ignore[override]
                if task_id.startswith("art-slide-deck-"):
                    raise TimeoutError("slide deck still running")
                return await super().wait_for_completion(notebook_id, task_id, timeout)

        class _TimeoutSlideClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.artifacts = _TimeoutSlideArtifacts(self.events)

        class _TimeoutSlideNotebookLMClient:
            last_client: _TimeoutSlideClient | None = None

            @classmethod
            async def from_storage(cls):
                cls.last_client = _TimeoutSlideClient()
                return cls.last_client

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            chunk_path = chunks_dir / "001-intro.md"
            chunk_path.write_text("# Intro\n\nBody\n", encoding="utf-8")

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_TimeoutSlideNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                notebook_id, uploads, studio_results = uploader.ingest_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    studios=StudiosConfig(
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

            state = json.loads((chunks_dir / ".nblm-run-state.json").read_text(encoding="utf-8"))

        self.assertEqual(notebook_id, "nb1")
        self.assertEqual(len(uploads), 1)
        self.assertEqual(len(studio_results), 1)
        self.assertEqual(studio_results[0].status, "pending")
        self.assertEqual(state["version"], 4)
        self.assertEqual(state["notebook_id"], "nb1")
        self.assertEqual(state["chunks"]["001-intro.md"]["studios"]["slide_deck"]["status"], "pending")
        self.assertEqual(
            state["chunks"]["001-intro.md"]["studios"]["slide_deck"]["task_id"],
            "art-slide-deck-1",
        )

    def test_ingest_directory_resumes_pending_slide_deck_task(self) -> None:
        uploader = NotebookLMPyUploader()

        class _ResumeSlideArtifacts(_FakeArtifactsAPI):
            def __init__(self, events: list[str]) -> None:
                super().__init__(events)
                self.wait_calls: list[tuple[str, str, float]] = []

            async def generate_slide_deck(self, *args, **kwargs):  # type: ignore[override]
                raise AssertionError("resume should not create a new slide deck task")

        class _ResumeSlideClient(_FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.artifacts = _ResumeSlideArtifacts(self.events)

        class _ResumeSlideNotebookLMClient:
            last_client: _ResumeSlideClient | None = None

            @classmethod
            async def from_storage(cls):
                cls.last_client = _ResumeSlideClient()
                return cls.last_client

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            chunk_path = chunks_dir / "001-intro.md"
            chunk_path.write_text("# Intro\n\nBody\n", encoding="utf-8")
            output_path = (root / "studio" / "slides" / "001-intro-slide-deck.pdf").resolve()
            state_payload = {
                "version": 1,
                "notebook_id": "nb-resume",
                "notebook_title": "Notebook",
                "chunks": {
                    "001-intro.md": {
                        "content_hash": chunk_content_hash(chunk_path),
                        "source_id": "src-001-intro",
                        "studios": {
                            "slide_deck": {
                                "status": "pending",
                                "task_id": "art-slide-deck-1",
                                "output_path": str(output_path),
                                "remote_title": None,
                                "error": "slide deck still running",
                            }
                        },
                    }
                },
                "notebook_studios": {},
            }
            (chunks_dir / ".nblm-run-state.json").write_text(
                json.dumps(state_payload, indent=2) + "\n",
                encoding="utf-8",
            )

            with patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_client_class",
                return_value=_ResumeSlideNotebookLMClient,
            ), patch(
                "notebooklm_chunker.uploaders.notebooklm_py._load_notebooklm_rpc_module",
                return_value=_FakeRpcModule,
            ):
                notebook_id, uploads, studio_results = uploader.ingest_directory(
                    chunks_dir,
                    notebook_title="Notebook",
                    studios=StudiosConfig(
                        slide_deck=StudioConfig(
                            enabled=True,
                            per_chunk=True,
                            output_dir=str((root / "studio" / "slides").resolve()),
                            download_format="pdf",
                            format="detailed",
                            length="default",
                        ),
                    ),
                    resume=True,
                )

        self.assertEqual(notebook_id, "nb-resume")
        self.assertEqual(len(uploads), 1)
        self.assertEqual(len(studio_results), 1)
        self.assertEqual(studio_results[0].status, "completed")
        self.assertEqual(_ResumeSlideNotebookLMClient.last_client.notebooks.created_titles, [])
        self.assertEqual(_ResumeSlideNotebookLMClient.last_client.sources.calls, [])
