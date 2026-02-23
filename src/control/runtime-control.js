"use strict";

const { nowEast8Iso } = require("../core/time");

class RuntimeControl {
  constructor(config, store, scheduler, sessionPool, worktreeManager = null, logger = console) {
    this.config = config;
    this.store = store;
    this.scheduler = scheduler;
    this.sessionPool = sessionPool;
    this.worktreeManager = worktreeManager;
    this.logger = logger;
  }

  getState() {
    return {
      paused: Boolean(this.scheduler?.isPaused?.()),
      pauseReason: this.scheduler?.getPauseReason?.() || null,
      pauseSource: this.scheduler?.getPauseSource?.() || null,
    };
  }

  pause({ reason = "manual pause" } = {}) {
    this.scheduler.pause(reason, "operator");
    const state = this.getState();
    this.logger.warn("[control] runtime paused", {
      event: "pause",
      error: null,
      reason,
      ...state,
    });
    return state;
  }

  resume({ reason = "manual resume" } = {}) {
    this.scheduler.resume(reason, "operator");
    const state = this.getState();
    this.logger.info("[control] runtime resumed", {
      event: "resume",
      error: null,
      reason,
      ...state,
    });
    return state;
  }

  cancel({ runId = null, storyId = null, reason = "cancelled_by_operator" } = {}) {
    const target = this._resolveTarget({ runId, storyId });
    const now = nowEast8Iso();

    if (target.run?.sessionId) this.sessionPool.kill(target.run.sessionId);

    if (target.run) {
      this.store.setRun({
        ...target.run,
        status: "cancelled",
        finishAt: target.run.finishAt || now,
        error: reason,
        errorCode: "RUN_CANCELLED",
        errorSource: "runtime_control",
      });
    }

    if (target.story) {
      this.store.setStory({
        ...target.story,
        status: "dead",
        deadAt: now,
        finishedAt: now,
        currentRunId: null,
        sessionId: null,
        error: reason,
        lastError: reason,
        errorCode: "RUN_CANCELLED",
        errorSource: "runtime_control",
      });
    }

    this.logger.warn("[control] run cancelled", {
      event: "cancel",
      storyId: target.story?.id || null,
      prdId: target.story?.prdId || null,
      phase: target.story?.phase || null,
      attempt: target.story?.attempt || null,
      traceId: target.story?.traceId || null,
      runId: target.run?.id || null,
      error: reason,
    });

    return {
      ok: true,
      action: "cancel",
      runId: target.run?.id || null,
      storyId: target.story?.id || null,
      status: target.story ? "dead" : null,
      reason,
    };
  }

  restart({ runId = null, storyId = null, reason = "restarted_by_operator", resetAttempts = false } = {}) {
    const target = this._resolveTarget({ runId, storyId });
    const now = nowEast8Iso();

    if (!target.story) {
      throw new Error("restart requires runId or storyId");
    }

    if (target.story.status === "dead" && resetAttempts !== true) {
      const err = new Error("dead story requires revive/reset before restart (set resetAttempts=true or use revive_dead)");
      err.code = "DEAD_STORY_REQUIRES_REVIVE";
      throw err;
    }

    if (target.run?.sessionId) this.sessionPool.kill(target.run.sessionId);

    if (target.run) {
      this.store.setRun({
        ...target.run,
        status: "restarted",
        finishAt: target.run.finishAt || now,
        error: reason,
        errorCode: "RUN_RESTARTED",
        errorSource: "runtime_control",
      });
    }

    const nextAttempt = resetAttempts ? 1 : ((target.story.attempt || 1) + 1);
    const nextMaxAttempts = Math.max(target.story.maxAttempts || this.config.maxAttempts || 3, nextAttempt);
    this.store.setStory({
      ...target.story,
      status: "pending",
      attempt: nextAttempt,
      maxAttempts: nextMaxAttempts,
      deadAt: null,
      finishedAt: null,
      currentRunId: null,
      sessionId: null,
      error: null,
      errorDetail: null,
      lastError: reason,
      errorCode: null,
      errorSource: null,
      retryable: true,
      finishAt: null,
      phaseFinishedAt: null,
    });

    const prd = target.story.prdId ? this.store.getPrd(target.story.prdId) : null;
    if (prd && (prd.status === "completed" || prd.status === "completed_with_errors")) {
      this.store.setPrd({ ...prd, status: "active" });
    }

    const pipeline = this.store.getPipeline();
    if (pipeline && pipeline.status === "failed") {
      this.store.setPipeline({ ...pipeline, status: "executing", error: null });
    }

    this.scheduler.resume("restart_requested", "operator");

    this.logger.warn("[control] run restarted", {
      event: "restart",
      storyId: target.story.id,
      prdId: target.story.prdId || null,
      phase: target.story.phase || null,
      attempt: nextAttempt,
      resetAttempts: Boolean(resetAttempts),
      traceId: target.story.traceId || null,
      runId: target.run?.id || null,
      error: null,
    });

    return {
      ok: true,
      action: "restart",
      runId: target.run?.id || null,
      storyId: target.story.id,
      status: "pending",
      attempt: nextAttempt,
      resetAttempts: Boolean(resetAttempts),
    };
  }

  async approveMerge({ runId = null, storyId = null, reason = "merge_approved_by_operator" } = {}) {
    const target = this._resolveTarget({ runId, storyId });
    const now = nowEast8Iso();

    if (!target.story) {
      throw new Error("approveMerge requires runId or storyId");
    }
    if (!this.worktreeManager) {
      const err = new Error("worktree manager not configured");
      err.code = "MERGE_MANAGER_NOT_AVAILABLE";
      throw err;
    }
    if (target.story.status !== "merging") {
      const err = new Error(`story ${target.story.id} is not waiting merge approval`);
      err.code = "MERGE_NOT_PENDING";
      throw err;
    }
    if (!target.story.worktreeId) {
      const err = new Error(`story ${target.story.id} has no worktree to merge`);
      err.code = "MERGE_WORKTREE_MISSING";
      throw err;
    }

    const result = await this.worktreeManager.merge(target.story.worktreeId);
    if (result?.ok) {
      this.store.transitionStory(target.story.id, "completed", {
        finishedAt: now,
        finishAt: now,
        mergeState: "approved",
        mergeApprovedAt: now,
        mergeReason: reason,
      });
      await this.worktreeManager.cleanup(target.story.worktreeId);
      this.logger.info("[control] merge approved and completed", {
        event: "merge",
        storyId: target.story.id,
        prdId: target.story.prdId || null,
        phase: target.story.phase || null,
        attempt: target.story.attempt || null,
        traceId: target.story.traceId || null,
        runId: target.run?.id || null,
        mergeState: "approved",
      });
      return {
        ok: true,
        action: "approve_merge",
        storyId: target.story.id,
        runId: target.run?.id || null,
        status: "completed",
      };
    }

    const conflictError = `merge conflict: ${(result?.conflicts || []).join(", ")}`;
    this.store.transitionStory(target.story.id, "failed", {
      error: conflictError,
      lastError: conflictError,
      errorCode: "MERGE_CONFLICT",
      errorSource: "runtime_control",
      retryable: true,
      mergeState: "conflict",
      mergeApprovedAt: now,
      mergeReason: reason,
    });
    this.logger.error("[control] merge approval failed with conflict", {
      event: "fail",
      storyId: target.story.id,
      prdId: target.story.prdId || null,
      phase: target.story.phase || null,
      attempt: target.story.attempt || null,
      traceId: target.story.traceId || null,
      runId: target.run?.id || null,
      error: conflictError,
    });
    return {
      ok: false,
      action: "approve_merge",
      storyId: target.story.id,
      runId: target.run?.id || null,
      status: "failed",
      conflicts: result?.conflicts || [],
    };
  }

  reviveDeadStories({ prdId = null, reason = "revived_dead_by_operator", resetAttempts = true } = {}) {
    const deadStories = this.store
      .listStories()
      .filter((story) => story.status === "dead" && (!prdId || story.prdId === prdId));

    if (!deadStories.length) {
      return {
        ok: true,
        action: "revive_dead",
        revivedCount: 0,
        prdId: prdId || null,
        storyIds: [],
      };
    }

    const touchedPrdIds = new Set();
    const revivedStoryIds = [];

    for (const story of deadStories) {
      const currentAttempt = story.attempt || 1;
      const nextAttempt = resetAttempts ? 1 : currentAttempt;
      const nextMaxAttempts = Math.max(story.maxAttempts || this.config.maxAttempts || 3, nextAttempt);
      this.store.setStory({
        ...story,
        status: "pending",
        attempt: nextAttempt,
        maxAttempts: nextMaxAttempts,
        deadAt: null,
        finishedAt: null,
        currentRunId: null,
        sessionId: null,
        error: null,
        errorDetail: null,
        lastError: reason,
        errorCode: null,
        errorSource: null,
        retryable: true,
        finishAt: null,
        phaseFinishedAt: null,
      });
      revivedStoryIds.push(story.id);
      if (story.prdId) touchedPrdIds.add(story.prdId);
    }

    for (const touchedPrdId of touchedPrdIds) {
      const prd = this.store.getPrd(touchedPrdId);
      if (!prd) continue;
      if (prd.status === "completed" || prd.status === "completed_with_errors") {
        this.store.setPrd({ ...prd, status: "active" });
      }
    }

    const pipeline = this.store.getPipeline();
    if (pipeline && pipeline.status === "failed") {
      this.store.setPipeline({ ...pipeline, status: "executing", error: null });
    }

    this.scheduler.resume("revive_dead_requested", "operator");

    this.logger.warn("[control] dead stories revived", {
      event: "revive_dead",
      prdId: prdId || null,
      revivedCount: revivedStoryIds.length,
      resetAttempts: Boolean(resetAttempts),
      storyIds: revivedStoryIds,
      error: null,
    });

    return {
      ok: true,
      action: "revive_dead",
      revivedCount: revivedStoryIds.length,
      prdId: prdId || null,
      resetAttempts: Boolean(resetAttempts),
      storyIds: revivedStoryIds,
    };
  }

  _resolveTarget({ runId, storyId }) {
    let run = null;
    let story = null;

    if (runId) {
      run = this.store.getRun(runId);
      if (!run) throw new Error(`run not found: ${runId}`);
      story = run.storyId ? this.store.getStory(run.storyId) : null;
    }

    if (!story && storyId) {
      story = this.store.getStory(storyId);
      if (!story) throw new Error(`story not found: ${storyId}`);
      if (!run && story.currentRunId) run = this.store.getRun(story.currentRunId);
    }

    if (!run && !story) {
      throw new Error("runId or storyId is required");
    }

    return { run, story };
  }
}

module.exports = { RuntimeControl };
