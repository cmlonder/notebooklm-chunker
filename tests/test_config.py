from __future__ import annotations

import tempfile
from pathlib import Path
from unittest import TestCase

from notebooklm_chunker.config import load_config, resolve_config_path, write_config_template


class ConfigTests(TestCase):
    def test_load_config_reads_nblm_toml(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[chunking]",
                        "min_pages = 1.5",
                        "max_pages = 3.0",
                        "words_per_page = 450",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            config = load_config(config_path)

        self.assertEqual(config.chunking.words_per_page, 450)
        self.assertEqual(config.source_path, str(config_path.resolve()))

    def test_resolve_config_path_finds_local_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "nblm.toml"
            config_path.write_text("", encoding="utf-8")
            nested = root / "docs" / "guides"
            nested.mkdir(parents=True)

            resolved = resolve_config_path(start_dir=nested)

        self.assertEqual(resolved, config_path.resolve())

    def test_write_config_template_creates_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config_path = write_config_template(
                Path(directory) / "nblm.toml",
                target_pages=3.0,
                min_pages=2.5,
                max_pages=4.0,
                words_per_page=500,
            )
            content = config_path.read_text(encoding="utf-8")

        self.assertIn("NotebookLM authentication is managed", content)
        self.assertIn("target_pages = 3.0", content)
        self.assertIn('skip_ranges = ["1-8", "399-420", "512"]', content)
        self.assertIn("[runtime]", content)
        self.assertIn("max_parallel_chunks = 1", content)
        self.assertIn("max_parallel_heavy_studios = 1", content)
        self.assertIn("# max_parallel = 4", content)
        self.assertIn("studio_wait_timeout_seconds = 7200", content)
        self.assertIn("studio_create_retries = 3", content)
        self.assertIn("studio_create_backoff_seconds = 2.0", content)
        self.assertIn("studio_rate_limit_cooldown_seconds = 30.0", content)
        self.assertIn("rename_remote_titles = false", content)
        self.assertIn("download_outputs = true", content)
        self.assertIn("[chunking]", content)
        self.assertIn('output_dir = "./output/{source_stem}/chunks"', content)
        self.assertIn('output_path = "./output/{source_stem}/studio/audio-overview.mp4"', content)

    def test_load_config_resolves_relative_source_and_studio_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "docs" / "book.pdf"
            source.parent.mkdir(parents=True)
            source.write_text("placeholder", encoding="utf-8")

            config_path = root / "configs" / "nblm.toml"
            config_path.parent.mkdir(parents=True)
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        'path = "../docs/book.pdf"',
                        'skip_ranges = ["1-8", "399-420"]',
                        "",
                        "[chunking]",
                        'output_dir = "../build/chunks"',
                        "target_pages = 3.0",
                        "",
                        "[runtime]",
                        "max_parallel_chunks = 5",
                        "max_parallel_heavy_studios = 2",
                        "studio_wait_timeout_seconds = 5400",
                        "studio_create_retries = 4",
                        "studio_create_backoff_seconds = 1.5",
                        "studio_rate_limit_cooldown_seconds = 45.0",
                        "rename_remote_titles = true",
                        "download_outputs = false",
                        "",
                        "[studios.audio]",
                        "enabled = true",
                        "per_chunk = true",
                        "max_parallel = 3",
                        'output_dir = "../build/studio/audio"',
                        'output_path = "../build/studio/audio-overview.mp4"',
                        'format = "deep-dive"',
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            config = load_config(config_path)

        self.assertEqual(config.source.path, str(source.resolve()))
        self.assertEqual(config.source.skip_ranges, ("1-8", "399-420"))
        self.assertEqual(config.chunking.target_pages, 3.0)
        self.assertEqual(config.chunking.output_dir, str((root / "build" / "chunks").resolve()))
        self.assertEqual(config.runtime.max_parallel_chunks, 5)
        self.assertEqual(config.runtime.max_parallel_heavy_studios, 2)
        self.assertEqual(config.runtime.studio_wait_timeout_seconds, 5400.0)
        self.assertEqual(config.runtime.studio_create_retries, 4)
        self.assertEqual(config.runtime.studio_create_backoff_seconds, 1.5)
        self.assertEqual(config.runtime.studio_rate_limit_cooldown_seconds, 45.0)
        self.assertTrue(config.runtime.rename_remote_titles)
        self.assertFalse(config.runtime.download_outputs)
        self.assertTrue(config.studios.audio.enabled)
        self.assertTrue(config.studios.audio.per_chunk)
        self.assertEqual(config.studios.audio.max_parallel, 3)
        self.assertEqual(
            config.studios.audio.output_dir,
            str((root / "build" / "studio" / "audio").resolve()),
        )
        self.assertEqual(
            config.studios.audio.output_path,
            str((root / "build" / "studio" / "audio-overview.mp4").resolve()),
        )

    def test_load_config_expands_source_stem_placeholder_in_output_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "docs" / "aviation.pdf"
            source.parent.mkdir(parents=True)
            source.write_text("placeholder", encoding="utf-8")

            config_path = root / "nblm.toml"
            config_path.write_text(
                "\n".join(
                    [
                        "[source]",
                        'path = "./docs/aviation.pdf"',
                        "",
                        "[chunking]",
                        'output_dir = "./output/{source_stem}/chunks"',
                        "",
                        "[studios.report]",
                        "enabled = true",
                        'output_path = "./output/{source_stem}/studio/report.md"',
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            config = load_config(config_path)

        self.assertEqual(
            config.chunking.output_dir,
            str((root / "output" / "aviation" / "chunks").resolve()),
        )
        self.assertEqual(
            config.studios.report.output_path,
            str((root / "output" / "aviation" / "studio" / "report.md").resolve()),
        )
