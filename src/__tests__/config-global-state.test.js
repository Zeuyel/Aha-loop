"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../config");

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function withTempCwd(fn) {
  const originalCwd = process.cwd();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aha-loop-config-"));
  process.chdir(tmpRoot);
  try {
    fn(tmpRoot);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function withEnv(key, value, fn) {
  const previous = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (previous == null) delete process.env[key];
    else process.env[key] = previous;
  }
}

runCase("default state file uses global home instead of cwd", () => {
  withTempCwd((tmpRoot) => {
    withEnv("AHA_LOOP_HOME", null, () => {
      withEnv("AHA_LOOP_STATE_FILE", null, () => {
        const config = loadConfig(["--workspace", tmpRoot]);
        assert.equal(config.workspace, path.resolve(tmpRoot));
        assert.notEqual(config.stateFile, path.resolve(tmpRoot, ".aha-loop", "state.json"));
        assert.equal(config.legacyWorkspaceStateFile, path.resolve(tmpRoot, ".aha-loop", "state.json"));
      });
    });
  });
});

runCase("AHA_LOOP_HOME overrides default global state location", () => {
  withTempCwd((tmpRoot) => {
    const customHome = path.join(tmpRoot, "custom-home");
    withEnv("AHA_LOOP_HOME", customHome, () => {
      withEnv("AHA_LOOP_STATE_FILE", null, () => {
        const config = loadConfig(["--workspace", tmpRoot]);
        assert.equal(config.globalHome, path.resolve(customHome));
        assert.equal(config.stateFile, path.resolve(customHome, "state.json"));
      });
    });
  });
});

runCase("--state-file relative path resolves against workspace", () => {
  withTempCwd((tmpRoot) => {
    const config = loadConfig(["--workspace", tmpRoot, "--state-file", ".aha-loop/custom-state.json"]);
    assert.equal(config.stateFile, path.resolve(tmpRoot, ".aha-loop", "custom-state.json"));
  });
});
