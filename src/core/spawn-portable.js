"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function spawnPortable(cmd, args = [], options = {}) {
  const textCmd = String(cmd || "");

  if (process.platform === "win32" && textCmd.toLowerCase() === "codex") {
    const codexScript = resolveCodexCliScript();
    if (codexScript) {
      return spawn(process.execPath, [codexScript, ...(args || [])], options);
    }
  }

  return spawn(textCmd, args, options);
}

function resolveCodexCliScript() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js"));
  }
  if (process.env.USERPROFILE) {
    candidates.push(
      path.join(
        process.env.USERPROFILE,
        "AppData",
        "Roaming",
        "npm",
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      ),
    );
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

module.exports = { spawnPortable };
