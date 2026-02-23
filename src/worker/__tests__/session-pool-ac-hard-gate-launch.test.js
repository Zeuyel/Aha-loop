"use strict";

const assert = require("node:assert/strict");
const { SessionPool } = require("../session-pool");

async function runCase(name, fn) {
  try {
    await fn();
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
    const item = this.sessions.get(id);
    return item ? { ...item } : null;
  }

  setRun(run) {
    this.runs.set(run.id, { ...run });
  }

  getRun(id) {
    const item = this.runs.get(id);
    return item ? { ...item } : null;
  }

  setStory(story) {
    this.stories.set(story.id, { ...story });
  }

  getStory(id) {
    const item = this.stories.get(id);
    return item ? { ...item } : null;
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
  const logger = { info() {}, warn() {}, error() {} };
  return new SessionPool(config, store, eventBus, logger);
}

function installFakeRunner(pool, result) {
  pool.phaseEngine = {
    start() {
      return {
        pid: 12345,
        command: {
          cmd: "codex",
          args: ["run"],
          cwd: process.cwd(),
        },
        cancel() {},
        wait: async () => ({ ...result }),
        getOutput: () => ({ stdout: result.stdout || "", stderr: result.stderr || "" }),
        getStats: () => null,
      };
    },
  };
}

(async () => {
  await runCase("launch blocks phase_done when AC exists but phaseResult is missing", async () => {
    const store = new FakeStore();
    const events = [];
    const pool = createPool(store, { fire: (name, payload) => events.push({ name, payload }) });

    store.setRun({ id: "run-1", storyId: "ST-1", status: "running" });
    store.setStory({ id: "ST-1", status: "running", phase: "implement" });

    const session = {
      id: "ses-1",
      runId: "run-1",
      storyId: "ST-1",
      prdId: "PRD-1",
      phase: "implement",
      attempt: 1,
      status: "running",
      startedAt: "2026-02-20T00:00:00.000+08:00",
    };

    installFakeRunner(pool, {
      exitCode: 0,
      stdout: "done",
      stderr: "",
      phase: "implement",
    });

    await pool.launch(session, {
      storyId: "ST-1",
      runId: "run-1",
      prdId: "PRD-1",
      phase: "implement",
      acceptanceCriteria: ["AC1"],
    });

    const savedSession = store.getSession("ses-1");
    const savedRun = store.getRun("run-1");
    const savedStory = store.getStory("ST-1");
    const lastEvent = events[events.length - 1];

    assert.equal(savedSession.status, "failed");
    assert.equal(savedRun.status, "fail");
    assert.equal(savedRun.errorCode, "PHASE_ACCEPTANCE_EVIDENCE_MISSING");
    assert.equal(savedStory.status, "failed");
    assert.equal(savedStory.errorCode, "PHASE_ACCEPTANCE_EVIDENCE_MISSING");
    assert.equal(lastEvent.name, "session:failed");
  });

  await runCase("launch blocks phase_done when AC checks are incomplete", async () => {
    const store = new FakeStore();
    const events = [];
    const pool = createPool(store, { fire: (name, payload) => events.push({ name, payload }) });

    store.setRun({ id: "run-2", storyId: "ST-2", status: "running" });
    store.setStory({ id: "ST-2", status: "running", phase: "review" });

    const session = {
      id: "ses-2",
      runId: "run-2",
      storyId: "ST-2",
      prdId: "PRD-2",
      phase: "review",
      attempt: 1,
      status: "running",
      startedAt: "2026-02-20T00:00:00.000+08:00",
    };

    installFakeRunner(pool, {
      exitCode: 0,
      stdout: "done",
      stderr: "",
      phase: "review",
      phaseResult: {
        status: "success",
        artifacts: {
          acceptanceCriteriaChecks: [{ id: "AC1", status: "pass" }],
        },
      },
    });

    await pool.launch(session, {
      storyId: "ST-2",
      runId: "run-2",
      prdId: "PRD-2",
      phase: "review",
      acceptanceCriteria: ["AC1", "AC2"],
    });

    const savedRun = store.getRun("run-2");
    const savedStory = store.getStory("ST-2");
    const lastEvent = events[events.length - 1];

    assert.equal(savedRun.status, "fail");
    assert.equal(savedRun.errorCode, "PHASE_ACCEPTANCE_EVIDENCE_INCOMPLETE");
    assert.equal(savedStory.status, "failed");
    assert.equal(savedStory.errorCode, "PHASE_ACCEPTANCE_EVIDENCE_INCOMPLETE");
    assert.equal(lastEvent.name, "session:failed");
  });

  await runCase("launch allows phase_done when AC checks all pass", async () => {
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

    installFakeRunner(pool, {
      exitCode: 0,
      stdout: "done",
      stderr: "",
      phase: "review",
      phaseResult: {
        status: "success",
        artifacts: {
          acceptanceCriteriaChecks: [
            { id: "AC1", status: "pass", evidence: "unit test passed" },
            { index: 1, status: "ok", evidence: "integration test passed" },
          ],
        },
      },
    });

    await pool.launch(session, {
      storyId: "ST-3",
      runId: "run-3",
      prdId: "PRD-3",
      phase: "review",
      acceptanceCriteria: ["AC1", "AC2"],
    });

    const savedSession = store.getSession("ses-3");
    const savedRun = store.getRun("run-3");
    const savedStory = store.getStory("ST-3");
    const lastEvent = events[events.length - 1];

    assert.equal(savedSession.status, "completed");
    assert.equal(savedRun.status, "success");
    assert.equal(savedStory.status, "phase_done");
    assert.equal(lastEvent.name, "session:completed");
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
