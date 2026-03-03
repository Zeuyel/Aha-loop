"use strict";

const assert = require("node:assert/strict");
const { SessionPool } = require("../session-pool");

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

class FakeStore {
  constructor() {
    this.sessions = new Map();
    this.runs = new Map();
    this.stories = new Map();
  }

  setSession(session) {
    this.sessions.set(session.id, { ...session });
  }

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  setRun(run) {
    this.runs.set(run.id, { ...run });
  }

  getRun(id) {
    return this.runs.get(id) || null;
  }

  setStory(story) {
    this.stories.set(story.id, { ...story });
  }

  getStory(id) {
    return this.stories.get(id) || null;
  }

  transitionStory(id, targetStatus, patch = {}) {
    const current = this.getStory(id);
    if (!current) throw new Error(`story not found: ${id}`);
    const next = { ...current, ...patch, status: targetStatus };
    this.setStory(next);
    return next;
  }
}

function createPool(store, eventBus) {
  const config = {
    sessionPollMs: 1000,
    storyTimeoutMs: 0,
    storyInactivityTimeoutMs: 0,
    dryRun: false,
  };
  const logger = {
    info() {},
    warn() {},
    error() {},
  };
  return new SessionPool(config, store, eventBus, logger);
}

runCase("finalize treats semantic failure (exit=0 + error) as failed", () => {
  const store = new FakeStore();
  const events = [];
  const pool = createPool(store, { fire: (name, payload) => events.push({ name, payload }) });

  store.setRun({ id: "run-1", storyId: "ST-1", status: "running" });
  store.setStory({ id: "ST-1", status: "running", phase: "plan" });

  const session = {
    id: "ses-1",
    runId: "run-1",
    storyId: "ST-1",
    prdId: "PRD-1",
    phase: "plan",
    attempt: 1,
    status: "running",
    startedAt: "2026-02-20T00:00:00.000+08:00",
  };
  pool._active.set(session.id, { session });

  pool._finalize(session.id, {
    exitCode: 0,
    error: {
      code: "PHASE_SEMANTIC_FAILURE",
      source: "session_pool",
      message: "semantic failure signal detected in stdout: 错误：缺少计划输入数据",
    },
    retryable: true,
    output: { stdout: "错误：缺少计划输入数据", stderr: "" },
  });

  const savedSession = store.getSession("ses-1");
  const savedRun = store.getRun("run-1");
  const savedStory = store.getStory("ST-1");
  const lastEvent = events[events.length - 1];

  assert.equal(savedSession.status, "failed");
  assert.equal(savedSession.exitCode, 0);
  assert.equal(savedRun.status, "fail");
  assert.equal(savedRun.errorCode, "PHASE_SEMANTIC_FAILURE");
  assert.equal(savedStory.status, "failed");
  assert.equal(savedStory.errorCode, "PHASE_SEMANTIC_FAILURE");
  assert.equal(lastEvent.name, "session:failed");
});

runCase("finalize keeps pure exit=0 without error as success", () => {
  const store = new FakeStore();
  const events = [];
  const pool = createPool(store, { fire: (name, payload) => events.push({ name, payload }) });

  store.setRun({ id: "run-2", storyId: "ST-2", status: "running" });
  store.setStory({ id: "ST-2", status: "running", phase: "plan" });

  const session = {
    id: "ses-2",
    runId: "run-2",
    storyId: "ST-2",
    prdId: "PRD-2",
    phase: "plan",
    attempt: 1,
    status: "running",
    startedAt: "2026-02-20T00:00:00.000+08:00",
  };
  pool._active.set(session.id, { session });

  pool._finalize(session.id, {
    exitCode: 0,
    error: null,
    retryable: true,
    output: { stdout: "done", stderr: "" },
  });

  const savedSession = store.getSession("ses-2");
  const savedRun = store.getRun("run-2");
  const savedStory = store.getStory("ST-2");
  const lastEvent = events[events.length - 1];

  assert.equal(savedSession.status, "completed");
  assert.equal(savedRun.status, "success");
  assert.equal(savedStory.status, "phase_done");
  assert.equal(lastEvent.name, "session:completed");
});

runCase("finalize keeps structured phase result on session and run", () => {
  const store = new FakeStore();
  const events = [];
  const pool = createPool(store, { fire: (name, payload) => events.push({ name, payload }) });

  store.setRun({ id: "run-3", storyId: "ST-3", status: "running" });
  store.setStory({ id: "ST-3", status: "running", phase: "review" });

  const session = {
    id: "ses-3",
    runId: "run-3",
    storyId: "ST-3",
    prdId: "PRD-3",
    phase: "review",
    attempt: 1,
    status: "running",
    startedAt: "2026-02-20T00:00:00.000+08:00",
  };
  pool._active.set(session.id, { session });

  const phaseResult = {
    status: "success",
    code: "OK",
    retryable: false,
    message: "review completed",
    artifacts: { report: ".aha-loop/runtime/phase/report.json" },
    nextAction: "advance",
  };

  pool._finalize(session.id, {
    exitCode: 0,
    error: null,
    retryable: true,
    output: { stdout: "done", stderr: "" },
    phaseResult,
  });

  const savedSession = store.getSession("ses-3");
  const savedRun = store.getRun("run-3");
  const lastEvent = events[events.length - 1];

  assert.deepEqual(savedSession.phaseResult, phaseResult);
  assert.deepEqual(savedRun.phaseResult, phaseResult);
  assert.deepEqual(lastEvent.payload.phaseResult, phaseResult);
});
