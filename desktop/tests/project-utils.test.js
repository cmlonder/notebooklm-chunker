const test = require("node:test");
const assert = require("node:assert/strict");

const {
  slugifyStem,
  nextVersionRawName,
  deriveProjectStatus,
  buildStudiosToml,
  parseNotebookId,
} = require("../renderer/project-utils.js");

test("slugifyStem creates stable lowercase project stems", () => {
  assert.equal(slugifyStem("Havacılık Domaini.pdf"), "havaclk-domaini");
  assert.equal(slugifyStem("DDD Quickly.pdf"), "ddd-quickly");
});

test("nextVersionRawName increments only when needed", () => {
  assert.equal(nextVersionRawName("ddd-quickly", []), "ddd-quickly-chunks");
  assert.equal(
    nextVersionRawName("ddd-quickly", ["ddd-quickly-chunks"]),
    "ddd-quickly-chunks-1",
  );
  assert.equal(
    nextVersionRawName("ddd-quickly", ["ddd-quickly-chunks", "ddd-quickly-chunks-1"]),
    "ddd-quickly-chunks-2",
  );
});

test("deriveProjectStatus reports synced projects", () => {
  const status = deriveProjectStatus({
    manifestEntries: [{ synced: true }, { synced: true }],
    metadata: { notebook_id: "nb1" },
    runState: {},
  });
  assert.equal(status.label, "Synced");
  assert.equal(status.tone, "green");
});

test("deriveProjectStatus reports quota blocks before sync status", () => {
  const status = deriveProjectStatus({
    manifestEntries: [{ synced: true }],
    metadata: { notebook_id: "nb1" },
    runState: {
      quota_blocks: {
        slide_deck: {
          blocked_until: "2026-03-11T10:00:00Z",
        },
      },
    },
  });
  assert.equal(status.label, "Quota blocked");
  assert.equal(status.detail, "slide_deck");
});

test("buildStudiosToml writes per-chunk studio config", () => {
  const toml = buildStudiosToml({
    outputDir: "./output/demo/chunks",
    notebookId: "nb1",
    maxParallelChunks: 3,
    downloadOutputs: false,
    studios: {
      quiz: {
        enabled: true,
        outputDir: "./output/demo/quizzes",
        quantity: "more",
        difficulty: "hard",
        prompt: "Ask practical questions.",
      },
    },
  });

  assert.match(toml, /\[chunking\]/);
  assert.match(toml, /download_outputs = false/);
  assert.match(toml, /\[studios\.quiz\]/);
  assert.match(toml, /per_chunk = true/);
  assert.match(toml, /quantity = "more"/);
});

test("buildStudiosToml omits per_chunk when disabled explicitly", () => {
  const toml = buildStudiosToml({
    outputDir: "./output/demo/chunks",
    notebookId: "nb1",
    maxParallelChunks: 3,
    downloadOutputs: true,
    studios: {
      report: {
        enabled: true,
        perChunk: false,
        outputDir: "./output/demo/reports",
      },
    },
  });

  assert.match(toml, /\[studios\.report\]/);
  assert.doesNotMatch(toml, /per_chunk = true/);
});

test("parseNotebookId extracts notebook id from CLI output", () => {
  assert.equal(parseNotebookId("Notebook ID: abc-123\nUploaded sources: 5"), "abc-123");
  assert.equal(parseNotebookId("no notebook"), null);
});
