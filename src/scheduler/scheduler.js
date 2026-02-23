"use strict";

const crypto = require("node:crypto");
const { nextPhase } = require("../store/schemas");
const { nowEast8Iso } = require("../core/time");

/**
 * 调度器 — 系统的大脑
 *
 * 定期轮询 Store，决定哪些 Story 可以执行:
 * 1. 推进 phase_done → 下一阶段或合并
 * 2. 处理 failed → 重试或判死
 * 3. 分发 pending → 检查依赖 → 创建 worktree → 发 RabbitMQ
 * 4. 检查 PRD 完成度
 */
class Scheduler {
  constructor(config, store, queue, worktreeManager, eventBus, logger = console) {
    this.config = config;
    this.store = store;
    this.queue = queue;
    this.worktreeManager = worktreeManager;
    this.eventBus = eventBus;
    this.logger = logger;
    this._timer = null;
    this._anomalyCache = new Set();
    this._paused = false;
    this._pauseReason = null;
    this._pauseSource = null;
  }

  start() {
    this.logger.info(`[scheduler] started (poll every ${this.config.schedulerPollMs}ms)`);
    this._timer = setInterval(() => this.poll().catch((e) => {
      this.logger.error(`[scheduler] poll error: ${e.message}`);
    }), this.config.schedulerPollMs);
    // 立即执行一次
    this.poll().catch((e) => this.logger.error(`[scheduler] initial poll error: ${e.message}`));
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.logger.info("[scheduler] stopped");
  }

  pause(reason = "manual_pause", source = "operator") {
    this._paused = true;
    this._pauseReason = reason || "paused";
    this._pauseSource = source || "unknown";
    this.logger.warn("[scheduler] paused", {
      event: "pause",
      error: null,
      reason: this._pauseReason,
      source: this._pauseSource,
    });
  }

  resume(reason = "manual_resume", source = "operator") {
    this._paused = false;
    this._pauseReason = null;
    this._pauseSource = null;
    this.logger.info("[scheduler] resumed", {
      event: "resume",
      error: null,
      reason,
      source,
    });
  }

  isPaused() {
    return this._paused;
  }

  getPauseReason() {
    return this._pauseReason;
  }

  getPauseSource() {
    return this._pauseSource;
  }

  async poll() {
    this.eventBus.fire("scheduler:heartbeat", { at: nowEast8Iso() });
    this._auditRuntimeConsistency();

    if (this._paused) return;

    const initialStories = this.store.listStories();
    if (this._triggerFailFastIfNeeded(initialStories)) return;

    // Step 1: 推进已完成阶段
    for (const story of initialStories.filter((s) => s.status === "phase_done")) {
      const next = nextPhase(story.phase, story.phases);
      if (next) {
        this.store.transitionStory(story.id, "pending", { phase: next, currentRunId: null });
        this.logger.info(`[scheduler] ${story.id}: phase ${story.phase} → ${next}`);
      } else {
        await this._startMerge(story);
      }
    }

    // Step 2: 处理失败
    for (const story of initialStories.filter((s) => s.status === "failed")) {
      if (story.retryable === false) {
        this.store.transitionStory(story.id, "dead", {
          deadAt: nowEast8Iso(),
          lastError: story.error || story.lastError || "non-retryable failure",
          currentRunId: null,
        });
        this.logger.error("[scheduler] story moved to dead state (non-retryable)", {
          event: "dead",
          runId: story.currentRunId || null,
          storyId: story.id,
          prdId: story.prdId || null,
          phase: story.phase || null,
          attempt: story.attempt || null,
          traceId: story.traceId || null,
          error: story.error || story.lastError || "non-retryable failure",
        });
        this.eventBus.fire("story:dead", { storyId: story.id });
      } else if (story.attempt < (story.maxAttempts || this.config.maxAttempts)) {
        const nextAttempt = (story.attempt || 1) + 1;
        this.store.transitionStory(story.id, "pending", {
          attempt: nextAttempt,
          lastError: story.error || story.lastError || null,
          error: null,
          currentRunId: null,
        });
        this.logger.warn("[scheduler] story retry scheduled", {
          event: "retry",
          runId: story.currentRunId || null,
          storyId: story.id,
          prdId: story.prdId || null,
          phase: story.phase || null,
          attempt: nextAttempt,
          traceId: story.traceId || null,
          error: story.error || story.lastError || null,
        });
        this.eventBus.fire("story:retry", { storyId: story.id, attempt: nextAttempt });
      } else {
        this.store.transitionStory(story.id, "dead", {
          deadAt: nowEast8Iso(),
          lastError: story.error || story.lastError || "max attempts exhausted",
          currentRunId: null,
        });
        this.logger.error("[scheduler] story moved to dead state", {
          event: "dead",
          runId: story.currentRunId || null,
          storyId: story.id,
          prdId: story.prdId || null,
          phase: story.phase || null,
          attempt: story.attempt || null,
          traceId: story.traceId || null,
          error: story.error || story.lastError || "max attempts exhausted",
        });
        this.eventBus.fire("story:dead", { storyId: story.id });
      }
    }

    const afterFailureStories = this.store.listStories();
    if (this._triggerFailFastIfNeeded(afterFailureStories)) return;

    // Step 3: 激活依赖满足的 PRD
    this._activateEligiblePrds();

    // Step 3: 分发可执行任务
    const currentStories = this.store.listStories();
    const storyMap = new Map(currentStories.map((story) => [story.id, story]));
    const prds = this.store.listPrds();
    const prdMap = new Map(prds.map((prd) => [prd.id, prd]));

    const runningCount = currentStories.filter((s) => s.status === "running" || s.status === "queued").length;
    const availableSlots = this.config.maxConcurrency - runningCount;
    const pendingCandidates = currentStories.filter((story) => (
      story.status === "pending"
      && this._isDispatchablePrd(story.prdId, prdMap)
      && this._dependenciesMet(story, storyMap, prdMap)
    ));
    const inFlightByProject = this._buildProjectInFlightMap(currentStories);
    const dispatchPlan = this._buildDispatchPlan(pendingCandidates, availableSlots, inFlightByProject);
    for (const story of dispatchPlan) {
      await this._dispatch(story);
    }

    // Step 4: PRD 完成度
    for (const prd of this.store.listPrds({ status: "active" })) {
      this._checkPrdCompletion(prd);
    }
  }

  _triggerFailFastIfNeeded(stories) {
    if (!this.config.failFastOnDead) return false;
    const deadStory = stories.find((s) => s.status === "dead");
    if (!deadStory) return false;

    if (!(this._paused && this._pauseSource === "fail_fast")) {
      this.pause(`dead story detected: ${deadStory.id}`, "fail_fast");
      const pipeline = this.store.getPipeline();
      if (pipeline?.status === "executing") {
        this.store.setPipeline({
          ...pipeline,
          status: "failed",
          error: `fail-fast triggered by dead story ${deadStory.id}`,
        });
      }
      this.logger.error("[scheduler] fail-fast triggered", {
        event: "fail",
        storyId: deadStory.id,
        prdId: deadStory.prdId || null,
        phase: deadStory.phase || null,
        attempt: deadStory.attempt || null,
        traceId: deadStory.traceId || null,
        error: `dead story detected: ${deadStory.id}`,
      });
    }
    return true;
  }

  _auditRuntimeConsistency() {
    const runningSessions = this.store.listSessions({ status: "running" });
    const runningSessionByStory = new Map();
    for (const session of runningSessions) {
      if (!session?.storyId) continue;
      if (!runningSessionByStory.has(session.storyId)) {
        runningSessionByStory.set(session.storyId, session);
      }
    }

    const stories = this.store.listStories();

    // story/session 不一致只记录 anomaly，不做状态迁移。
    for (const [storyId, session] of runningSessionByStory.entries()) {
      const story = this.store.getStory(storyId);
      if (!story) continue;
      if (story.status === "running" && story.sessionId === session.id) {
        this._anomalyCache.delete(`STORY_SESSION_MISMATCH:${story.id}`);
        continue;
      }

      this._emitAnomalyOnce("STORY_SESSION_MISMATCH", story.id, {
        storyId: story.id,
        prdId: story.prdId || null,
        phase: story.phase || null,
        attempt: story.attempt || null,
        traceId: story.traceId || null,
        sessionId: session.id,
        error: {
          code: "STORY_SESSION_MISMATCH",
          source: "scheduler_audit",
          message: "running session exists but story state/sessionId is inconsistent",
        },
      });
    }

    for (const story of stories.filter((s) => s.status === "running")) {
      if (runningSessionByStory.has(story.id)) {
        this._anomalyCache.delete(`RUNNING_WITHOUT_SESSION:${story.id}`);
        continue;
      }
      if (this._recoverRunningWithoutSession(story)) {
        this._anomalyCache.delete(`RUNNING_WITHOUT_SESSION:${story.id}`);
        continue;
      }
      this._emitAnomalyOnce("RUNNING_WITHOUT_SESSION", story.id, {
        storyId: story.id,
        prdId: story.prdId || null,
        phase: story.phase || null,
        attempt: story.attempt || null,
        traceId: story.traceId || null,
        sessionId: story.sessionId || null,
        error: {
          code: "RUNNING_WITHOUT_SESSION",
          source: "scheduler_audit",
          message: "running story has no active running session",
        },
      });
    }
  }

  _recoverRunningWithoutSession(story) {
    if (!story || story.status !== "running") return false;
    const now = nowEast8Iso();
    const run = story.currentRunId ? this.store.getRun(story.currentRunId) : null;
    const runStatus = String(run?.status || "").toLowerCase();

    // If run already succeeded but story stuck in running, advance phase.
    if (runStatus === "success") {
      try {
        this.store.transitionStory(story.id, "phase_done", {
          error: null,
          errorDetail: null,
          errorCode: null,
          errorSource: null,
          retryable: true,
          phaseFinishedAt: run.finishAt || now,
          finishAt: run.finishAt || now,
          currentRunId: run.id || story.currentRunId || null,
          sessionId: null,
        });
        this.logger.warn("[scheduler] recovered running story without session (advanced to phase_done)", {
          event: "recover",
          storyId: story.id,
          prdId: story.prdId || null,
          phase: story.phase || null,
          attempt: story.attempt || null,
          traceId: story.traceId || null,
          runId: run.id || null,
          error: null,
        });
        return true;
      } catch (error) {
        this.logger.error("[scheduler] failed to recover running story to phase_done", {
          event: "anomaly",
          storyId: story.id,
          prdId: story.prdId || null,
          phase: story.phase || null,
          attempt: story.attempt || null,
          traceId: story.traceId || null,
          runId: run?.id || null,
          error: error?.message || String(error),
        });
        return false;
      }
    }

    if (run && (runStatus === "running" || runStatus === "queued")) {
      this.store.setRun({
        ...run,
        status: "fail",
        finishAt: run.finishAt || now,
        exitCode: run.exitCode ?? -1,
        error: run.error || "running story has no active running session",
        errorCode: run.errorCode || "RUNNING_WITHOUT_SESSION",
        errorSource: run.errorSource || "scheduler_audit",
      });
    }

    const latestRun = story.currentRunId ? this.store.getRun(story.currentRunId) : null;
    const failureMessage = latestRun?.error || "running story has no active running session";
    try {
      this.store.transitionStory(story.id, "failed", {
        error: failureMessage,
        lastError: failureMessage,
        errorDetail: {
          code: "RUNNING_WITHOUT_SESSION",
          source: "scheduler_audit",
          message: "running story has no active running session",
        },
        errorCode: latestRun?.errorCode || "RUNNING_WITHOUT_SESSION",
        errorSource: latestRun?.errorSource || "scheduler_audit",
        retryable: true,
        currentRunId: story.currentRunId || null,
        sessionId: null,
        finishAt: latestRun?.finishAt || now,
        phaseFinishedAt: latestRun?.finishAt || now,
      });
      this.logger.warn("[scheduler] recovered running story without session (moved to failed)", {
        event: "recover",
        storyId: story.id,
        prdId: story.prdId || null,
        phase: story.phase || null,
        attempt: story.attempt || null,
        traceId: story.traceId || null,
        runId: latestRun?.id || null,
        error: failureMessage,
      });
      return true;
    } catch (error) {
      this.logger.error("[scheduler] failed to recover running story without session", {
        event: "anomaly",
        storyId: story.id,
        prdId: story.prdId || null,
        phase: story.phase || null,
        attempt: story.attempt || null,
        traceId: story.traceId || null,
        runId: latestRun?.id || null,
        error: error?.message || String(error),
      });
      return false;
    }
  }

  _emitAnomalyOnce(code, storyId, meta) {
    const key = `${code}:${storyId}`;
    if (this._anomalyCache.has(key)) return;
    this._anomalyCache.add(key);
    this.logger.warn("[scheduler] anomaly detected", {
      event: "anomaly",
      ...meta,
    });
  }

  /** 检查 story 的依赖是否全部 completed */
  _dependenciesMet(story, storyMap, prdMap) {
    const refs = Array.isArray(story.dependencies) ? story.dependencies : [];
    const storyDependencies = refs.filter((ref) => !this._isPrdRef(ref));
    const prdDependencies = [
      ...(Array.isArray(story.prdDependencies) ? story.prdDependencies : []),
      ...refs.filter((ref) => this._isPrdRef(ref)),
    ];

    const storiesReady = storyDependencies.every((depId) => {
      const dep = storyMap.get(depId);
      return dep && dep.status === "completed";
    });
    if (!storiesReady) return false;

    return prdDependencies.every((depPrdId) => {
      const depPrd = prdMap.get(depPrdId);
      return depPrd && (depPrd.status === "completed" || depPrd.status === "completed_with_errors");
    });
  }

  _activateEligiblePrds() {
    const prds = this.store.listPrds();
    if (prds.length === 0) return;

    const prdMap = new Map(prds.map((prd) => [prd.id, prd]));
    for (const prd of prds) {
      if (prd.status !== "queued") continue;
      if (!this._prdDependenciesMet(prd, prdMap)) continue;
      this.store.transitionPrd(prd.id, "active");
      this.logger.info(`[scheduler] PRD ${prd.id}: queued → active (dependencies satisfied)`);
      prd.status = "active";
    }
  }

  _prdDependenciesMet(prd, prdMap) {
    const dependencies = Array.isArray(prd.dependencies) ? prd.dependencies : [];
    if (dependencies.length === 0) return true;
    return dependencies.every((depId) => {
      const depPrd = prdMap.get(depId);
      return depPrd && (depPrd.status === "completed" || depPrd.status === "completed_with_errors");
    });
  }

  _isDispatchablePrd(prdId, prdMap) {
    if (!prdId) return true;
    const prd = prdMap.get(prdId);
    if (!prd) return true;
    return prd.status === "active";
  }

  _isPrdRef(ref) {
    return /^PRD[-_]/i.test(String(ref || "").trim());
  }

  _projectKey(projectId) {
    const normalized = String(projectId || "").trim();
    return normalized || "__default__";
  }

  _buildProjectInFlightMap(stories) {
    const map = new Map();
    for (const story of stories) {
      if (story.status !== "running" && story.status !== "queued") continue;
      const key = this._projectKey(story.projectId);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }

  _buildDispatchPlan(pendingStories, availableSlots, inFlightByProject = new Map()) {
    if (!Number.isFinite(availableSlots) || availableSlots <= 0) return [];
    if (!Array.isArray(pendingStories) || pendingStories.length === 0) return [];

    const projectLimit = this._normalizePositiveInt(this.config.maxConcurrencyPerProject);
    const buckets = new Map();
    for (const story of pendingStories) {
      const key = this._projectKey(story.projectId);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(story);
      if (!inFlightByProject.has(key)) inFlightByProject.set(key, 0);
    }

    const keys = Array.from(buckets.keys()).sort((a, b) => {
      const inFlightA = inFlightByProject.get(a) || 0;
      const inFlightB = inFlightByProject.get(b) || 0;
      if (inFlightA !== inFlightB) return inFlightA - inFlightB;
      return a.localeCompare(b);
    });

    const plan = [];
    while (plan.length < availableSlots) {
      let progressed = false;
      for (const key of keys) {
        const bucket = buckets.get(key);
        if (!bucket || bucket.length === 0) continue;

        const inFlightCount = inFlightByProject.get(key) || 0;
        if (projectLimit && inFlightCount >= projectLimit) continue;

        const story = bucket.shift();
        plan.push(story);
        inFlightByProject.set(key, inFlightCount + 1);
        progressed = true;
        if (plan.length >= availableSlots) break;
      }
      if (!progressed) break;
    }
    return plan;
  }

  _normalizePositiveInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  }

  /** 分发 story 到 RabbitMQ */
  async _dispatch(story) {
    let worktreePath = this.config.workspace;
    let wtId = null;
    const runId = `run-${crypto.randomUUID().slice(0, 12)}`;
    const traceId = story.traceId || `trace-${crypto.randomUUID().slice(0, 12)}`;
    const dispatchAt = nowEast8Iso();
    const projectId = story.projectId || null;

    try {
      const wt = await this.worktreeManager.ensure(story);
      worktreePath = wt.path;
      wtId = wt.id;
    } catch (err) {
      const failedAt = nowEast8Iso();
      this.store.setRun({
        id: runId,
        storyId: story.id,
        prdId: story.prdId || null,
        projectId,
        phase: story.phase || null,
        status: "fail",
        attempt: story.attempt || 1,
        traceId,
        sessionId: null,
        dispatchAt,
        startAt: null,
        finishAt: failedAt,
        exitCode: null,
        error: err?.message || String(err),
        errorCode: err?.code || "WORKTREE_PREPARE_FAILED",
        errorSource: "scheduler_dispatch",
        createdAt: dispatchAt,
      });
      this.store.transitionStory(story.id, "failed", {
        error: err?.message || String(err),
        lastError: err?.message || String(err),
        errorCode: err?.code || "WORKTREE_PREPARE_FAILED",
        errorSource: "scheduler_dispatch",
      });
      throw err;
    }

    this.store.transitionStory(story.id, "queued", {
      worktreeId: wtId,
      traceId,
      dispatchAt,
      lastError: null,
      error: null,
      currentRunId: runId,
    });

    this.store.setRun({
      id: runId,
      storyId: story.id,
      prdId: story.prdId || null,
      projectId,
      phase: story.phase || null,
      status: "queued",
      attempt: story.attempt || 1,
      traceId,
      sessionId: null,
      dispatchAt,
      startAt: null,
      finishAt: null,
      exitCode: null,
      error: null,
      errorCode: null,
      errorSource: null,
      createdAt: dispatchAt,
    });

    try {
      await this.queue.publishTask({
        runId,
        storyId: story.id,
        storyTitle: story.title || story.id,
        prdId: story.prdId,
        projectId,
        phase: story.phase,
        acceptanceCriteria: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [],
        worktreeId: wtId,
        worktreePath,
        workspacePath: this.config.workspace,
        tool: story.tool || this.config.defaultTool,
        attempt: story.attempt || 1,
        maxAttempts: story.maxAttempts || this.config.maxAttempts,
        timeoutMs: story.timeoutMs ?? this.config.storyTimeoutMs,
        inactivityTimeoutMs: story.inactivityTimeoutMs ?? this.config.storyInactivityTimeoutMs,
        traceId,
        dispatchAt,
        publishedAt: dispatchAt,
      });
    } catch (err) {
      const failedAt = nowEast8Iso();
      const existingRun = this.store.getRun(runId) || {
        id: runId,
        storyId: story.id,
        prdId: story.prdId || null,
        projectId,
        phase: story.phase || null,
        attempt: story.attempt || 1,
        traceId,
        createdAt: dispatchAt,
      };
      this.store.setRun({
        ...existingRun,
        status: "fail",
        finishAt: failedAt,
        error: err?.message || String(err),
        errorCode: err?.code || "DISPATCH_PUBLISH_FAILED",
        errorSource: "scheduler_dispatch",
      });
      this.store.transitionStory(story.id, "failed", {
        error: err?.message || String(err),
        lastError: err?.message || String(err),
        errorCode: err?.code || "DISPATCH_PUBLISH_FAILED",
        errorSource: "scheduler_dispatch",
      });
      throw err;
    }

    this.logger.info("[scheduler] story dispatched", {
      event: "dispatch",
      runId,
      storyId: story.id,
      prdId: story.prdId || null,
      phase: story.phase || null,
      attempt: story.attempt || 1,
      traceId,
    });
  }

  /** 开始合并 worktree */
  async _startMerge(story) {
    // 无 worktree 模式 → 直接完成
    if (this.config.ahaLoopRoot || !story.worktreeId) {
      this.store.transitionStory(story.id, "merging");
      this.store.transitionStory(story.id, "completed", { finishedAt: nowEast8Iso() });
      this.logger.info("[scheduler] merge skipped and marked completed", {
        event: "merge",
        storyId: story.id,
        prdId: story.prdId || null,
        phase: story.phase || null,
        attempt: story.attempt || null,
        traceId: story.traceId || null,
        mergeState: "skipped",
      });
      return;
    }

    if (String(this.config.mergeMode || "manual_gate").toLowerCase() !== "auto") {
      this.store.transitionStory(story.id, "merging", {
        mergeState: "pending_approval",
        mergeRequestedAt: nowEast8Iso(),
      });
      this.logger.info("[scheduler] merge gated and waiting for explicit approval", {
        event: "merge",
        storyId: story.id,
        prdId: story.prdId || null,
        phase: story.phase || null,
        attempt: story.attempt || null,
        traceId: story.traceId || null,
        mergeState: "pending_approval",
        mergeMode: this.config.mergeMode || "manual_gate",
      });
      return;
    }

    this.store.transitionStory(story.id, "merging");
    this.logger.info("[scheduler] merging worktree", {
      event: "merge",
      storyId: story.id,
      prdId: story.prdId || null,
      phase: story.phase || null,
      attempt: story.attempt || null,
      traceId: story.traceId || null,
      mergeState: "start",
    });

    try {
      const result = await this.worktreeManager.merge(story.worktreeId);
      if (result.ok) {
        this.store.transitionStory(story.id, "completed", { finishedAt: nowEast8Iso() });
        await this.worktreeManager.cleanup(story.worktreeId);
        this.logger.info("[scheduler] worktree merged", {
          event: "merge",
          storyId: story.id,
          prdId: story.prdId || null,
          phase: story.phase || null,
          attempt: story.attempt || null,
          traceId: story.traceId || null,
          mergeState: "success",
        });
      } else {
        this.store.transitionStory(story.id, "failed", {
          error: `merge conflict: ${(result.conflicts || []).join(", ")}`,
        });
        this.logger.error("[scheduler] merge conflict", {
          event: "fail",
          storyId: story.id,
          prdId: story.prdId || null,
          phase: story.phase || null,
          attempt: story.attempt || null,
          traceId: story.traceId || null,
          error: `merge conflict: ${(result.conflicts || []).join(", ")}`,
        });
      }
    } catch (err) {
      this.store.transitionStory(story.id, "failed", { error: err.message });
      this.logger.error("[scheduler] merge error", {
        event: "fail",
        storyId: story.id,
        prdId: story.prdId || null,
        phase: story.phase || null,
        attempt: story.attempt || null,
        traceId: story.traceId || null,
        error: err,
      });
    }
  }

  /** 检查 PRD 是否所有 story 都完成了 */
  _checkPrdCompletion(prd) {
    const stories = this.store.listStories({ prdId: prd.id });
    if (stories.length === 0) return;

    const allTerminal = stories.every((s) => s.status === "completed" || s.status === "dead");
    if (!allTerminal) return;

    const hasDead = stories.some((s) => s.status === "dead");
    if (hasDead) {
      this.store.transitionPrd(prd.id, "completed_with_errors");
      this.logger.warn(`[scheduler] PRD ${prd.id}: completed with errors`);
    } else {
      this.store.transitionPrd(prd.id, "completed");
      this.logger.info(`[scheduler] PRD ${prd.id}: completed`);
    }
  }
}

module.exports = { Scheduler };
