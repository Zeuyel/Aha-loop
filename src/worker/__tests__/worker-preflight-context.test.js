"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("../worker");

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function createWorker(loggerOverrides = {}) {
  const config = { maxConcurrency: 1, maxAttempts: 3 };
  const store = {};
  const sessionPool = {};
  const eventBus = {};
  const logger = { info() {}, warn() {}, error() {}, ...loggerOverrides };
  return new Worker(config, store, sessionPool, eventBus, logger);
}

function withTempWorktree(writePrd, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-preflight-"));
  const aha = path.join(root, ".aha-loop");
  fs.mkdirSync(aha, { recursive: true });
  if (writePrd) {
    fs.writeFileSync(path.join(aha, "prd.json"), JSON.stringify(writePrd, null, 2));
  }
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

runCase("preflight rejects missing prd.json", () => {
  const worker = createWorker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-preflight-"));
  try {
    const result = worker._preflightStoryContext(
      { worktreePath: root, prdId: "PRD-010" },
      { id: "PRD-010-S03", prdId: "PRD-010" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "STORY_CONTEXT_FILE_MISSING");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

runCase("preflight rejects prd mismatch", () => {
  withTempWorktree(
    { prdId: "PRD-014", stories: [{ id: "PRD-014-S01" }] },
    (root) => {
      const worker = createWorker();
      const result = worker._preflightStoryContext(
        { worktreePath: root, prdId: "PRD-010" },
        { id: "PRD-010-S03", prdId: "PRD-010" },
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "STORY_CONTEXT_PRD_MISMATCH");
    },
  );
});

runCase("preflight rejects missing story definition", () => {
  withTempWorktree(
    { prdId: "PRD-010", stories: [{ id: "PRD-010-S01" }] },
    (root) => {
      const worker = createWorker();
      const result = worker._preflightStoryContext(
        { worktreePath: root, prdId: "PRD-010" },
        { id: "PRD-010-S03", prdId: "PRD-010" },
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "STORY_CONTEXT_STORY_NOT_FOUND");
    },
  );
});

runCase("preflight accepts matched prd and story", () => {
  withTempWorktree(
    { prdId: "PRD-010", stories: [{ id: "PRD-010-S03" }] },
    (root) => {
      const worker = createWorker();
      const result = worker._preflightStoryContext(
        { worktreePath: root, prdId: "PRD-010" },
        { id: "PRD-010-S03", prdId: "PRD-010" },
      );
      assert.equal(result.ok, true);
    },
  );
});

runCase("preflight writes runtime snapshot instead of mutating prd.json", () => {
  withTempWorktree(
    {
      prdId: "PRD-010",
      projectId: "proj-010",
      stories: [{ id: "PRD-010-S03", status: "dead", phase: "plan", attempt: 4, maxAttempts: 4 }],
    },
    (root) => {
      const worker = createWorker();
      const result = worker._preflightStoryContext(
        {
          worktreePath: root,
          prdId: "PRD-010",
          projectId: "proj-010",
          phase: "review",
          attempt: 4,
          maxAttempts: 4,
        },
        {
          id: "PRD-010-S03",
          prdId: "PRD-010",
          projectId: "proj-010",
          status: "queued",
          phase: "review",
          attempt: 4,
          maxAttempts: 4,
        },
      );
      assert.equal(result.ok, true);

      const data = JSON.parse(fs.readFileSync(path.join(root, ".aha-loop", "prd.json"), "utf8"));
      assert.equal(data.stories[0].status, "dead");
      assert.equal(data.stories[0].phase, "plan");
      assert.equal(data.stories[0].attempt, 4);
      assert.equal(data.stories[0].maxAttempts, 4);

      const runtime = JSON.parse(
        fs.readFileSync(path.join(root, ".aha-loop", "runtime", "story-context.json"), "utf8"),
      );
      assert.equal(runtime.prdId, "PRD-010");
      assert.equal(runtime.projectId, "proj-010");
      assert.equal(runtime.stories["PRD-010-S03"].status, "queued");
      assert.equal(runtime.stories["PRD-010-S03"].phase, "review");
      assert.equal(runtime.stories["PRD-010-S03"].attempt, 4);
      assert.equal(runtime.stories["PRD-010-S03"].maxAttempts, 4);
      assert.equal(runtime.stories["PRD-010-S03"].projectId, "proj-010");
    },
  );
});

runCase("preflight continues when runtime snapshot write fails", () => {
  withTempWorktree(
    { prdId: "PRD-010", stories: [{ id: "PRD-010-S03", status: "dead", phase: "plan" }] },
    (root) => {
      const warns = [];
      const worker = createWorker({
        warn: (...args) => warns.push(args),
      });

      const originalWrite = fs.writeFileSync;
      fs.writeFileSync = () => {
        throw new Error("disk full");
      };
      try {
        const result = worker._preflightStoryContext(
          { worktreePath: root, prdId: "PRD-010", phase: "review", attempt: 2, maxAttempts: 4 },
          {
            id: "PRD-010-S03",
            prdId: "PRD-010",
            status: "queued",
            phase: "review",
            attempt: 2,
            maxAttempts: 4,
          },
        );
        assert.equal(result.ok, true);
      } finally {
        fs.writeFileSync = originalWrite;
      }

      assert.equal(warns.length, 1);
      const meta = warns[0][1] || {};
      assert.equal(meta.event, "anomaly");
      assert.equal(meta.storyId, "PRD-010-S03");
      assert.match(String(meta.error || ""), /disk full/);
    },
  );
});
