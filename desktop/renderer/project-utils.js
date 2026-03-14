(function initProjectUtils(globalScope) {
  function slugifyStem(fileName) {
    return String(fileName || "")
      .replace(/\.[^.]+$/, "")
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[_\s]+/g, "-")
      .replace(/-+/g, "-")
      .toLowerCase();
  }

  function nextVersionRawName(baseStem, existingRawNames) {
    const normalized = new Set((existingRawNames || []).map(String));
    const baseName = `${baseStem}-chunks`;
    if (!normalized.has(baseName)) {
      return baseName;
    }
    let index = 1;
    while (normalized.has(`${baseName}-${index}`)) {
      index += 1;
    }
    return `${baseName}-${index}`;
  }

  function parseQuotaBlocks(runState) {
    if (!runState || typeof runState !== "object") {
      return [];
    }
    const blocks = runState.quota_blocks || {};
    return Object.entries(blocks)
      .filter(([, block]) => block && typeof block.blocked_until === "string")
      .map(([studioName, block]) => ({ studioName, blockedUntil: block.blocked_until }));
  }

  function deriveProjectStatus({ manifestEntries, metadata, runState }) {
    const entries = Array.isArray(manifestEntries) ? manifestEntries : [];
    const syncedCount = entries.filter((entry) => entry && entry.synced === true).length;
    const changedCount = entries.filter((entry) => entry && entry.synced !== true).length;
    const blockedStudios = parseQuotaBlocks(runState);

    if (blockedStudios.length > 0) {
      return {
        label: "Quota blocked",
        tone: "amber",
        detail: blockedStudios.map((item) => item.studioName).join(", "),
      };
    }
    if (!metadata || !metadata.notebook_id) {
      return {
        label: entries.length > 0 ? "Local draft" : "Empty draft",
        tone: "slate",
        detail: `${entries.length} chunk${entries.length === 1 ? "" : "s"}`,
      };
    }
    if (entries.length > 0 && changedCount === 0) {
      return {
        label: "Synced",
        tone: "green",
        detail: `${syncedCount} source${syncedCount === 1 ? "" : "s"}`,
      };
    }
    return {
      label: "Needs sync",
      tone: "blue",
      detail: `${changedCount} changed`,
    };
  }

  function buildStudiosToml({
    outputDir,
    notebookId,
    maxParallelChunks,
    studios,
    downloadOutputs,
  }) {
    const lines = [
      "[chunking]",
      `output_dir = ${JSON.stringify(outputDir)}`,
      "",
      "[notebook]",
      `id = ${JSON.stringify(notebookId)}`,
      "",
      "[runtime]",
      `max_parallel_chunks = ${Number(maxParallelChunks || 3)}`,
      `download_outputs = ${downloadOutputs === false ? "false" : "true"}`,
    ];
    for (const [studioName, config] of Object.entries(studios || {})) {
      if (!config || !config.enabled) {
        continue;
      }
      lines.push("", `[studios.${studioName}]`, "enabled = true");
      if (config.perChunk !== false) {
        lines.push("per_chunk = true");
      }
      if (config.maxParallel) {
        lines.push(`max_parallel = ${Number(config.maxParallel)}`);
      }
      if (config.outputDir) {
        lines.push(`output_dir = ${JSON.stringify(config.outputDir)}`);
      }
      if (config.language) {
        lines.push(`language = ${JSON.stringify(config.language)}`);
      }
      if (config.format) {
        lines.push(`format = ${JSON.stringify(config.format)}`);
      }
      if (config.length) {
        lines.push(`length = ${JSON.stringify(config.length)}`);
      }
      if (config.downloadFormat) {
        lines.push(`download_format = ${JSON.stringify(config.downloadFormat)}`);
      }
      if (config.quantity) {
        lines.push(`quantity = ${JSON.stringify(config.quantity)}`);
      }
      if (config.difficulty) {
        lines.push(`difficulty = ${JSON.stringify(config.difficulty)}`);
      }
      if (config.prompt) {
        lines.push('prompt = """', String(config.prompt).trim(), '"""');
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  function parseNotebookId(output) {
    const match = String(output || "").match(/Notebook ID:\s*([a-f0-9-]+)/i);
    return match ? match[1].trim() : null;
  }

  const exported = {
    slugifyStem,
    nextVersionRawName,
    deriveProjectStatus,
    buildStudiosToml,
    parseNotebookId,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  globalScope.projectUtils = exported;
})(typeof globalThis !== "undefined" ? globalThis : window);
