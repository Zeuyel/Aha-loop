"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

async function migrateLegacyWorkspaceStateIfNeeded(config, logger = console) {
  const target = config?.stateFile;
  const source = config?.legacyWorkspaceStateFile;
  if (!target || !source) return { migrated: false, reason: "missing_path" };

  const absTarget = path.resolve(target);
  const absSource = path.resolve(source);
  if (absTarget === absSource) return { migrated: false, reason: "same_path" };
  if (fs.existsSync(absTarget)) return { migrated: false, reason: "target_exists" };
  if (!fs.existsSync(absSource)) return { migrated: false, reason: "source_missing" };

  await fsp.mkdir(path.dirname(absTarget), { recursive: true });
  await fsp.copyFile(absSource, absTarget);

  logger.info("[state] migrated legacy workspace state", {
    event: "state_migrated",
    from: absSource,
    to: absTarget,
  });

  return { migrated: true, from: absSource, to: absTarget };
}

module.exports = { migrateLegacyWorkspaceStateIfNeeded };
