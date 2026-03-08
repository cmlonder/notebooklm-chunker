from __future__ import annotations

import io
import tempfile
import textwrap
from contextlib import redirect_stderr, redirect_stdout
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from notebooklm_chunker.cli import main
from notebooklm_chunker.doctor import DoctorCheck, DoctorReport
from notebooklm_chunker.models import Block


class CliTests(TestCase):
    def test_version_flag_prints_package_version(self) -> None:
        stdout = io.StringIO()
        with self.assertRaises(SystemExit) as exit_context:
            with redirect_stdout(stdout):
                main(["--version"])

        self.assertEqual(exit_context.exception.code, 0)
        self.assertIn("nblm 0.2.1", stdout.getvalue())

    def test_prepare_command_exports_chunks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "book.md"
            output_dir = Path(directory) / "chunks"
            source.write_text(
                textwrap.dedent(
                    """
                    # Chapter 1

                    This is a paragraph with enough text to be chunked.
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main(
                    [
                        "prepare",
                        str(source),
                        "-o",
                        str(output_dir),
                        "--target-pages",
                        "0.5",
                        "--min-pages",
                        "0.1",
                        "--max-pages",
                        "1",
                    ]
                )

            manifest_exists = (output_dir / "manifest.json").exists()

        self.assertEqual(exit_code, 0)
        self.assertTrue(manifest_exists)
        self.assertIn("Chunks generated:", stdout.getvalue())

    def test_prepare_command_aborts_when_output_dir_is_not_empty_and_user_declines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "book.md"
            output_dir = Path(directory) / "chunks"
            output_dir.mkdir()
            (output_dir / "manifest.json").write_text("[]\n", encoding="utf-8")
            source.write_text("# Chapter 1\n\nBody\n", encoding="utf-8")

            stderr = io.StringIO()
            with patch("builtins.input", return_value="n"):
                with redirect_stderr(stderr):
                    exit_code = main(
                        [
                            "prepare",
                            str(source),
                            "-o",
                            str(output_dir),
                        ]
                    )

        self.assertEqual(exit_code, 2)
        self.assertIn("Aborted because the chunk output folder is not empty.", stderr.getvalue())

    def test_run_command_overwrites_non_empty_output_dir_with_yes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.md"
            source.write_text("# Chapter 1\n\nBody\n", encoding="utf-8")
            output_dir = root / "chunks"
            output_dir.mkdir()
            (output_dir / "manifest.json").write_text("[]\n", encoding="utf-8")
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        f'path = "{source.name}"',
                        "",
                        "[chunking]",
                        'output_dir = "./chunks"',
                        "min_pages = 0.1",
                        "max_pages = 1.0",
                        "words_per_page = 500",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            with patch("notebooklm_chunker.cli.NotebookLMPyUploader") as mocked_uploader_class:
                mocked_uploader = mocked_uploader_class.return_value
                mocked_uploader.ingest_directory.return_value = ("nb1", [], [])
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = main(["run", "--config", str(config_path), "--yes"])

        self.assertEqual(exit_code, 0)
        mocked_uploader.ingest_directory.assert_called_once()
        self.assertIn("Notebook ID: nb1", stdout.getvalue())

    def test_resume_command_aborts_when_saved_quota_block_is_still_active(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.md"
            source.write_text("# Chapter 1\n\nBody\n", encoding="utf-8")
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            blocked_until = (
                (datetime.now(UTC) + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
            )
            (chunks_dir / ".nblm-run-state.json").write_text(
                textwrap.dedent(
                    f"""
                    {{
                      "version": 4,
                      "notebook_id": "nb1",
                      "chunks": {{}},
                      "notebook_studios": {{}},
                      "quota_blocks": {{
                        "report": {{
                          "blocked_until": "{blocked_until}",
                          "last_error": "quota exceeded"
                        }}
                      }}
                    }}
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        f'path = "{source.name}"',
                        "",
                        "[chunking]",
                        'output_dir = "./chunks"',
                        "min_pages = 0.1",
                        "max_pages = 1.0",
                        "words_per_page = 500",
                        "",
                        "[studios.report]",
                        "enabled = true",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            stderr = io.StringIO()
            with patch("builtins.input", return_value="n"):
                with redirect_stderr(stderr):
                    exit_code = main(["resume", "--config", str(config_path)])

        self.assertEqual(exit_code, 2)
        self.assertIn("Studio quotas are likely still blocked", stderr.getvalue())

    def test_init_command_writes_config_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "nblm.toml"
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main(["init", "-o", str(config_path)])

            content = config_path.read_text(encoding="utf-8")

        self.assertEqual(exit_code, 0)
        self.assertIn("[chunking]", content)
        self.assertIn("Config file:", stdout.getvalue())

    def test_login_command_runs_notebooklm_login(self) -> None:
        with tempfile.TemporaryDirectory():
            stdout = io.StringIO()
            with patch("notebooklm_chunker.cli.run_notebooklm_login") as mocked_login:
                with redirect_stdout(stdout):
                    exit_code = main(["login"])

        self.assertEqual(exit_code, 0)
        mocked_login.assert_called_once_with()

    def test_logout_command_clears_local_auth_state(self) -> None:
        stdout = io.StringIO()
        with patch(
            "notebooklm_chunker.cli.run_notebooklm_logout",
            return_value=(["/tmp/.notebooklm/storage_state.json"], None),
        ) as mocked_logout:
            with redirect_stdout(stdout):
                exit_code = main(["logout"])

        self.assertEqual(exit_code, 0)
        mocked_logout.assert_called_once_with()
        self.assertIn("Removed local NotebookLM auth state:", stdout.getvalue())

    def test_doctor_command_prints_report(self) -> None:
        stdout = io.StringIO()
        report = DoctorReport(
            checks=(
                DoctorCheck(name="config", status="ok", summary="/tmp/nblm.toml"),
                DoctorCheck(name="auth", status="warn", summary="No NotebookLM auth state found."),
            ),
            local_chunking_ready=True,
            live_run_ready=False,
        )
        with patch("notebooklm_chunker.cli.run_doctor", return_value=report) as mocked_doctor:
            with redirect_stdout(stdout):
                exit_code = main(["doctor"])

        self.assertEqual(exit_code, 0)
        mocked_doctor.assert_called_once_with(None)
        self.assertIn("Doctor", stdout.getvalue())
        self.assertIn("local-chunking=yes", stdout.getvalue())

    def test_doctor_command_returns_nonzero_when_failures_exist(self) -> None:
        report = DoctorReport(
            checks=(DoctorCheck(name="config", status="fail", summary="Invalid TOML"),),
            local_chunking_ready=False,
            live_run_ready=False,
        )
        with patch("notebooklm_chunker.cli.run_doctor", return_value=report):
            exit_code = main(["doctor"])

        self.assertEqual(exit_code, 1)

    def test_upload_command_uses_notebooklm_py_uploader(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            chunks_dir = Path(directory) / "chunks"
            chunks_dir.mkdir()

            with patch("notebooklm_chunker.cli.NotebookLMPyUploader") as mocked_uploader_class:
                mocked_uploader = mocked_uploader_class.return_value
                mocked_uploader.upload_directory.return_value = ("nb1", [])
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = main(["upload", str(chunks_dir)])

        self.assertEqual(exit_code, 0)
        mocked_uploader.upload_directory.assert_called_once()
        self.assertEqual(
            mocked_uploader.upload_directory.call_args.kwargs["max_parallel_chunks"], 1
        )
        self.assertEqual(
            mocked_uploader.upload_directory.call_args.kwargs["studio_wait_timeout_seconds"], 7200.0
        )
        self.assertEqual(
            mocked_uploader.upload_directory.call_args.kwargs["studio_rate_limit_cooldown_seconds"],
            30.0,
        )
        self.assertEqual(
            mocked_uploader.upload_directory.call_args.kwargs["rename_remote_titles"], False
        )

    def test_studios_command_uses_saved_run_state_for_per_chunk_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunks_dir = root / "chunks"
            chunks_dir.mkdir()
            (chunks_dir / ".nblm-run-state.json").write_text("{}", encoding="utf-8")
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[chunking]",
                        'output_dir = "./chunks"',
                        "",
                        "[studios.quiz]",
                        "enabled = true",
                        "per_chunk = true",
                        'output_dir = "./quizzes"',
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            with patch("notebooklm_chunker.cli.NotebookLMPyUploader") as mocked_uploader_class:
                mocked_uploader = mocked_uploader_class.return_value
                mocked_uploader.run_studios.return_value = []
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = main(["studios", "--config", str(config_path)])

        self.assertEqual(exit_code, 0)
        mocked_uploader.run_studios.assert_called_once()
        self.assertIsNone(mocked_uploader.run_studios.call_args.kwargs["notebook_id"])
        self.assertEqual(
            mocked_uploader.run_studios.call_args.kwargs["run_state_path"].resolve(),
            (chunks_dir / ".nblm-run-state.json").resolve(),
        )

    def test_prepare_command_reports_missing_input_file_cleanly(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            exit_code = main(["prepare", "example.md"])

        self.assertEqual(exit_code, 2)
        self.assertIn("Input file not found: example.md", stderr.getvalue())

    def test_prepare_command_reads_chunking_settings_from_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.md"
            source.write_text(
                textwrap.dedent(
                    """
                    # Chapter 1

                    Body text for config-driven input.
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[chunking]",
                        "min_pages = 0.1",
                        "max_pages = 1.0",
                        "words_per_page = 500",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            output_dir = root / "chunks"

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main(
                    ["prepare", str(source), "--config", str(config_path), "-o", str(output_dir)]
                )

            manifest_exists = (output_dir / "manifest.json").exists()

        self.assertEqual(exit_code, 0)
        self.assertTrue(manifest_exists)
        self.assertIn("Chunks generated:", stdout.getvalue())

    def test_prepare_command_reads_source_from_config_when_input_is_omitted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.md"
            source.write_text(
                textwrap.dedent(
                    """
                    # Chapter 1

                    Body text for config-driven source resolution.
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        f'path = "{source.name}"',
                        "",
                        "[chunking]",
                        'output_dir = "./chunks"',
                        "min_pages = 0.1",
                        "max_pages = 1.0",
                        "words_per_page = 500",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main(["prepare", "--config", str(config_path)])

            manifest_exists = (root / "chunks" / "manifest.json").exists()

        self.assertEqual(exit_code, 0)
        self.assertTrue(manifest_exists)
        self.assertIn("Output folder:", stdout.getvalue())

    def test_prepare_command_forwards_pdf_skip_settings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.pdf"
            source.write_text("placeholder", encoding="utf-8")
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        f'path = "{source.name}"',
                        'skip_ranges = ["1-8", "399-420"]',
                        "",
                        "[chunking]",
                        'output_dir = "./chunks"',
                        "target_pages = 3.0",
                        "min_pages = 2.5",
                        "max_pages = 4.0",
                        "words_per_page = 500",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            with (
                patch(
                    "notebooklm_chunker.cli.inspect_pdf_page_selection",
                    return_value=type(
                        "Selection",
                        (),
                        {
                            "total_pages": 420,
                            "included_pages": tuple(range(9, 399)),
                            "skipped_pages": tuple(list(range(1, 9)) + list(range(399, 421))),
                        },
                    )(),
                ),
                patch(
                    "notebooklm_chunker.cli.parse_document",
                    return_value=[
                        Block(kind="heading", text="Chapter 1", level=1, page=3),
                        Block(kind="paragraph", text="Body", page=3),
                    ],
                ) as mocked_parse,
            ):
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = main(["prepare", "--config", str(config_path)])

        self.assertEqual(exit_code, 0)
        mocked_parse.assert_called_once_with(
            source.resolve(),
            pdf_skip_ranges=("1-8", "399-420"),
        )

    def test_prepare_command_cli_skip_range_overrides_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.pdf"
            source.write_text("placeholder", encoding="utf-8")
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        f'path = "{source.name}"',
                        'skip_ranges = ["1-8"]',
                        "",
                        "[chunking]",
                        'output_dir = "./chunks"',
                        "target_pages = 3.0",
                        "min_pages = 2.5",
                        "max_pages = 4.0",
                        "words_per_page = 500",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            with (
                patch(
                    "notebooklm_chunker.cli.inspect_pdf_page_selection",
                    return_value=type(
                        "Selection",
                        (),
                        {
                            "total_pages": 420,
                            "included_pages": tuple(
                                list(range(10, 21)) + list(range(21, 40)) + list(range(41, 421))
                            ),
                            "skipped_pages": tuple(list(range(1, 10)) + list(range(40, 41))),
                        },
                    )(),
                ),
                patch(
                    "notebooklm_chunker.cli.parse_document",
                    return_value=[
                        Block(kind="heading", text="Chapter 1", level=1, page=3),
                        Block(kind="paragraph", text="Body", page=3),
                    ],
                ) as mocked_parse,
            ):
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = main(
                        [
                            "prepare",
                            "--config",
                            str(config_path),
                            "--skip-range",
                            "10-20",
                            "--skip-range",
                            "40",
                        ]
                    )

        self.assertEqual(exit_code, 0)
        mocked_parse.assert_called_once_with(
            source.resolve(),
            pdf_skip_ranges=("10-20", "40"),
        )

    def test_prepare_command_logs_pdf_page_selection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.pdf"
            source.write_text("placeholder", encoding="utf-8")
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        f'path = "{source.name}"',
                        'skip_ranges = ["1-8", "399-420"]',
                        "",
                        "[chunking]",
                        'output_dir = "./chunks"',
                        "target_pages = 3.0",
                        "min_pages = 2.5",
                        "max_pages = 4.0",
                        "words_per_page = 500",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            with (
                patch(
                    "notebooklm_chunker.cli.inspect_pdf_page_selection",
                    return_value=type(
                        "Selection",
                        (),
                        {
                            "total_pages": 420,
                            "included_pages": tuple(range(9, 399)),
                            "skipped_pages": tuple(list(range(1, 9)) + list(range(399, 421))),
                        },
                    )(),
                ),
                patch(
                    "notebooklm_chunker.cli.parse_document",
                    return_value=[
                        Block(kind="heading", text="Foreword", level=1, page=9),
                        Block(kind="paragraph", text="Body", page=9),
                    ],
                ),
            ):
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = main(["prepare", "--config", str(config_path)])

        self.assertEqual(exit_code, 0)
        self.assertIn(
            "PDF physical pages kept 390/420 (first=9, last=398, skipped=30)",
            stdout.getvalue(),
        )

    def test_run_command_reports_generated_studios(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.md"
            source.write_text(
                textwrap.dedent(
                    """
                    # Chapter 1

                    Body text for run command.
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        f'path = "{source.name}"',
                        "",
                        "[chunking]",
                        'output_dir = "./chunks"',
                        "min_pages = 0.1",
                        "max_pages = 1.0",
                        "words_per_page = 500",
                        "",
                        "[runtime]",
                        "max_parallel_chunks = 5",
                        "max_parallel_heavy_studios = 2",
                        "studio_wait_timeout_seconds = 5400",
                        "rename_remote_titles = true",
                        "download_outputs = false",
                        "studio_rate_limit_cooldown_seconds = 45.0",
                        "",
                        "[studios.audio]",
                        "enabled = true",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            with patch("notebooklm_chunker.cli.NotebookLMPyUploader") as mocked_uploader_class:
                mocked_uploader = mocked_uploader_class.return_value
                mocked_uploader.ingest_directory.return_value = (
                    "nb1",
                    [],
                    [
                        type(
                            "StudioResult", (), {"studio": "audio", "output_path": "/tmp/audio.mp4"}
                        )()
                    ],
                )
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = main(["run", "--config", str(config_path)])

        self.assertEqual(exit_code, 0)
        mocked_uploader.ingest_directory.assert_called_once()
        self.assertEqual(
            mocked_uploader.ingest_directory.call_args.kwargs["max_parallel_chunks"], 5
        )
        self.assertEqual(
            mocked_uploader.ingest_directory.call_args.kwargs["max_parallel_heavy_studios"], 2
        )
        self.assertEqual(
            mocked_uploader.ingest_directory.call_args.kwargs["studio_wait_timeout_seconds"], 5400.0
        )
        self.assertEqual(
            mocked_uploader.ingest_directory.call_args.kwargs["studio_create_retries"], 3
        )
        self.assertEqual(
            mocked_uploader.ingest_directory.call_args.kwargs["studio_create_backoff_seconds"], 2.0
        )
        self.assertEqual(
            mocked_uploader.ingest_directory.call_args.kwargs["studio_rate_limit_cooldown_seconds"],
            45.0,
        )
        self.assertEqual(
            mocked_uploader.ingest_directory.call_args.kwargs["rename_remote_titles"], True
        )
        self.assertEqual(
            mocked_uploader.ingest_directory.call_args.kwargs["download_outputs"], False
        )
        self.assertEqual(mocked_uploader.ingest_directory.call_args.kwargs["resume"], False)
        self.assertIn("Generated studios: 1", stdout.getvalue())
        self.assertIn("audio: /tmp/audio.mp4", stdout.getvalue())

    def test_run_command_cli_parallel_override_wins_over_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.md"
            source.write_text("# Chapter 1\n\nBody text.\n", encoding="utf-8")
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        f'path = "{source.name}"',
                        "",
                        "[chunking]",
                        'output_dir = "./chunks"',
                        "min_pages = 0.1",
                        "max_pages = 1.0",
                        "words_per_page = 500",
                        "",
                        "[runtime]",
                        "max_parallel_chunks = 2",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            with patch("notebooklm_chunker.cli.NotebookLMPyUploader") as mocked_uploader_class:
                mocked_uploader = mocked_uploader_class.return_value
                mocked_uploader.ingest_directory.return_value = ("nb1", [], [])
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = main(
                        [
                            "run",
                            "--config",
                            str(config_path),
                            "--max-parallel-chunks",
                            "7",
                        ]
                    )

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            mocked_uploader.ingest_directory.call_args.kwargs["max_parallel_chunks"], 7
        )

    def test_resume_command_sets_resume_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.md"
            source.write_text("# Chapter 1\n\nBody text.\n", encoding="utf-8")
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        f'path = "{source.name}"',
                        "",
                        "[chunking]",
                        'output_dir = "./chunks"',
                        "min_pages = 0.1",
                        "max_pages = 1.0",
                        "words_per_page = 500",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            with patch("notebooklm_chunker.cli.NotebookLMPyUploader") as mocked_uploader_class:
                mocked_uploader = mocked_uploader_class.return_value
                mocked_uploader.ingest_directory.return_value = ("nb1", [], [])
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = main(["resume", "--config", str(config_path)])

        self.assertEqual(exit_code, 0)
        self.assertEqual(mocked_uploader.ingest_directory.call_args.kwargs["resume"], True)

    def test_resume_command_cli_parallel_override_wins_over_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "book.md"
            source.write_text("# Chapter 1\n\nBody text.\n", encoding="utf-8")
            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        f'path = "{source.name}"',
                        "",
                        "[chunking]",
                        'output_dir = "./chunks"',
                        "min_pages = 0.1",
                        "max_pages = 1.0",
                        "words_per_page = 500",
                        "",
                        "[runtime]",
                        "max_parallel_chunks = 2",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            with patch("notebooklm_chunker.cli.NotebookLMPyUploader") as mocked_uploader_class:
                mocked_uploader = mocked_uploader_class.return_value
                mocked_uploader.ingest_directory.return_value = ("nb1", [], [])
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = main(
                        [
                            "resume",
                            "--config",
                            str(config_path),
                            "--max-parallel-chunks",
                            "7",
                        ]
                    )

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            mocked_uploader.ingest_directory.call_args.kwargs["max_parallel_chunks"], 7
        )
