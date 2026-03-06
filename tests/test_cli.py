from __future__ import annotations

import io
import tempfile
import textwrap
from contextlib import redirect_stdout
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
from contextlib import redirect_stderr

from notebooklm_chunker.models import Block
from notebooklm_chunker.cli import main
from notebooklm_chunker.doctor import DoctorCheck, DoctorReport


class CliTests(TestCase):
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
        with tempfile.TemporaryDirectory() as directory:
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
                exit_code = main(["prepare", str(source), "--config", str(config_path), "-o", str(output_dir)])

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

            with patch(
                "notebooklm_chunker.cli.parse_document",
                return_value=[Block(kind="heading", text="Chapter 1", level=1, page=3), Block(kind="paragraph", text="Body", page=3)],
            ) as mocked_parse:
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

            with patch(
                "notebooklm_chunker.cli.parse_document",
                return_value=[Block(kind="heading", text="Chapter 1", level=1, page=3), Block(kind="paragraph", text="Body", page=3)],
            ) as mocked_parse:
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
                    [type("StudioResult", (), {"studio": "audio", "output_path": "/tmp/audio.mp4"})()],
                )
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = main(["run", "--config", str(config_path)])

        self.assertEqual(exit_code, 0)
        mocked_uploader.ingest_directory.assert_called_once()
        self.assertIn("Generated studios: 1", stdout.getvalue())
        self.assertIn("audio: /tmp/audio.mp4", stdout.getvalue())
