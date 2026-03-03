"use strict";

const assert = require("node:assert/strict");
const { RuntimeControl } = require("../runtime-control");

const CASES = [];
function runCase(name, fn) {
  CASES.push({ name, fn });
}

class FakeStore {
  constructor() {
    this.stories = new Map();
    this.runs = new Map();
    this.prds = new Map();
    this.pipeline = { status: "executing" };
  }

  listStories() {
    return Array.from(this.stories.values()).map((story) => ({ ...story }));
  }

  setStory(story) {
    this.stories.set(story.id, { ...story });
  }

  transitionStory(id, targetStatus, patch = {}) {
    const current = this.getStory(id);
    if (!current) throw new Error(`story not found: ${id}`);
    const next = { ...current, ...patch, status: targetStatus };
    this.setStory(next);
    return next;
  }

  getStory(id) {
    return this.stories.get(id) || null;
  }

  setRun(run) {
    this.runs.set(run.id, { ...run });
  }

  getRun(id) {
    return this.runs.get(id) || null;
  }

  getPrd(id) {
    return this.prds.get(id) || null;
  }

  setPrd(prd) {
    this.prds.set(prd.id, { ...prd });
  }

  getPipeline() {
    return this.pipeline ? { ...this.pipeline } : null;
  }

  setPipeline(pipeline) {
    this.pipeline = { ...pipeline };
  }
}

function createControl(store, overrides = {}) {
  const scheduler = {
    resumed: 0,
    resume() {
      this.resumed += 1;
    },
  };
  const sessionPool = { kill() {} };
  const worktreeManager = {
    async merge() { return { ok: true }; },
    async cleanup() {},
    ...(overrides.worktreeManager || {}),
  };
  const logger = { info() {}, warn() {}, error() {} };
  const control = new RuntimeControl({ maxAttempts: 4 }, store, scheduler, sessionPool, worktreeManager, logger);
  return { control, scheduler };
}

runCase("reviveDeadStories resets attempt by default", () => {
  const store = new FakeStore();
  store.setStory({
    id: "PRD-016-S02",
    prdId: "PRD-016",
    status: "dead",
    phase: "plan",
    attempt: 4,
    maxAttempts: 4,
    errorCode: "PHASE_SEMANTIC_FAILURE",
    errorDetail: { foo: "bar" },
  });
  const { control } = createControl(store);

  const result = control.reviveDeadStories({ prdId: "PRD-016", reason: "operator_revive" });
  const story = store.getStory("PRD-016-S02");

  assert.equal(result.ok, true);
  assert.equal(result.revivedCount, 1);
  assert.equal(result.resetAttempts, true);
  assert.equal(story.status, "pending");
  assert.equal(story.attempt, 1);
  assert.equal(story.maxAttempts, 4);
  assert.equal(story.errorCode, null);
  assert.equal(story.errorDetail, null);
});

runCase("reviveDeadStories can preserve attempt when resetAttempts=false", () => {
  const store = new FakeStore();
  store.setStory({
    id: "PRD-016-S03",
    prdId: "PRD-016",
    status: "dead",
    phase: "plan",
    attempt: 3,
    maxAttempts: 4,
  });
  const { control } = createControl(store);

  const result = control.reviveDeadStories({
    prdId: "PRD-016",
    reason: "operator_revive",
    resetAttempts: false,
  });
  const story = store.getStory("PRD-016-S03");

  assert.equal(result.ok, true);
  assert.equal(result.resetAttempts, false);
  assert.equal(story.status, "pending");
  assert.equal(story.attempt, 3);
  assert.equal(story.maxAttempts, 4);
});

runCase("restart can reset attempt when resetAttempts=true", () => {
  const store = new FakeStore();
  store.setStory({
    id: "PRD-016-S02",
    prdId: "PRD-016",
    status: "dead",
    phase: "implement",
    attempt: 4,
    maxAttempts: 4,
    errorCode: "PHASE_EXEC_FAILED",
    errorDetail: { code: "PHASE_EXEC_FAILED" },
  });
  const { control } = createControl(store);

  const result = control.restart({
    storyId: "PRD-016-S02",
    reason: "provider_503_recovery",
    resetAttempts: true,
  });
  const story = store.getStory("PRD-016-S02");

  assert.equal(result.ok, true);
  assert.equal(result.status, "pending");
  assert.equal(result.resetAttempts, true);
  assert.equal(story.status, "pending");
  assert.equal(story.attempt, 1);
  assert.equal(story.maxAttempts, 4);
  assert.equal(story.errorCode, null);
  assert.equal(story.errorDetail, null);
});

runCase("restart blocks dead story when resetAttempts=false", () => {
  const store = new FakeStore();
  store.setStory({
    id: "PRD-016-S03",
    prdId: "PRD-016",
    status: "dead",
    phase: "implement",
    attempt: 4,
    maxAttempts: 4,
  });
  const { control } = createControl(store);

  assert.throws(
    () => control.restart({
      storyId: "PRD-016-S03",
      reason: "manual_retry",
      resetAttempts: false,
    }),
    (error) => error && error.code === "DEAD_STORY_REQUIRES_REVIVE",
  );
  const story = store.getStory("PRD-016-S03");

  assert.equal(story.status, "dead");
  assert.equal(story.attempt, 4);
  assert.equal(story.maxAttempts, 4);
});

runCase("approveMerge completes story when merge gate is pending", async () => {
  const store = new FakeStore();
  store.setStory({
    id: "PRD-016-S04",
    prdId: "PRD-016",
    status: "merging",
    mergeState: "pending_approval",
    phase: "review",
    attempt: 1,
    worktreeId: "wt-004",
  });
  const { control } = createControl(store);

  const result = await control.approveMerge({
    storyId: "PRD-016-S04",
    reason: "operator_approved",
  });
  const story = store.getStory("PRD-016-S04");

  assert.equal(result.ok, true);
  assert.equal(story.status, "completed");
  assert.equal(story.mergeState, "approved");
});

async function main() {
  for (const testCase of CASES) {
    try {
      await testCase.fn();
      console.log(`PASS ${testCase.name}`);
    } catch (error) {
      console.error(`FAIL ${testCase.name}`);
      throw error;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
