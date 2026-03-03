"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { nowEast8Iso } = require("../core/time");

class WorkerBackpressureError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerBackpressureError";
    this.code = "WORKER_BACKPRESSURE";
    this.requeue = true;
    this.retryable = true;
  }
}

/**
 * Worker — 从 RabbitMQ 消费任务，交给 SessionPool 执行
 * 不做任何调度决策
 */
class Worker {
  constructor(config, store, sessionPool, eventBus, logger = console) {
    this.config = config;
    this.store = store;
    this.sessionPool = sessionPool;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  /** 启动消费循环 */
  async start(queue) {
    await queue.consumeTasks((task) => this.handleTask(task));
    this.logger.info("[worker] consumer started");
  }

  /**
   * 处理单条任务消息
   * @param {Object} task - 从 MQ 消费的任务
   */
  async handleTask(task) {
    const { storyId, runId } = task;
    if (!storyId) throw new Error("task missing storyId");
    if (!runId) throw new Error("task missing runId");

    // 幂等检查: 同 storyId 是否已有 running session
    const existing = this.store.listSessions({ storyId, status: "running" });
    const staleSessions = existing.filter((session) => !this.sessionPool.isSessionActive(session.id));
    if (staleSessions.length > 0) {
      const now = nowEast8Iso();
      for (const stale of staleSessions) {
        this.store.setSession({
          ...stale,
          status: "failed",
          finishedAt: stale.finishedAt || now,
          finishAt: stale.finishAt || now,
          exitCode: stale.exitCode ?? -1,
          retryable: true,
          error: {
            code: "STALE_SESSION_RECOVERED",
            source: "worker_preflight",
            message: "stale running session recovered before duplicate-session check",
          },
        });
        if (stale.runId) {
          const staleRun = this.store.getRun(stale.runId);
          if (staleRun && staleRun.status === "running") {
            this.store.setRun({
              ...staleRun,
              status: "fail",
              finishAt: staleRun.finishAt || now,
              exitCode: staleRun.exitCode ?? -1,
              error: "stale running session recovered before duplicate-session check",
              errorCode: "STALE_SESSION_RECOVERED",
              errorSource: "worker_preflight",
            });
          }
        }
      }
      const staleSessionIds = new Set(staleSessions.map((s) => s.id));
      const staleStory = this.store.getStory(storyId);
      if (staleStory?.status === "running" && (!staleStory.sessionId || staleSessionIds.has(staleStory.sessionId))) {
        const staleRunId = staleStory.currentRunId || null;
        const staleRun = staleRunId ? this.store.getRun(staleRunId) : null;
        const staleRunStatus = String(staleRun?.status || "").toLowerCase();
        if (staleRun && (staleRunStatus === "running" || staleRunStatus === "queued")) {
          this.store.setRun({
            ...staleRun,
            status: "fail",
            finishAt: staleRun.finishAt || now,
            exitCode: staleRun.exitCode ?? -1,
            error: staleRun.error || "running story has no active running session",
            errorCode: staleRun.errorCode || "RUNNING_WITHOUT_SESSION",
            errorSource: staleRun.errorSource || "worker_preflight",
          });
        }
        try {
          const latestRun = staleRunId ? this.store.getRun(staleRunId) : null;
          const recoveredError = latestRun?.error || "running story has no active running session";
          this.store.transitionStory(staleStory.id, "failed", {
            error: recoveredError,
            lastError: recoveredError,
            errorDetail: {
              code: "RUNNING_WITHOUT_SESSION",
              source: "worker_preflight",
              message: "stale running session recovered before duplicate-session check",
              staleSessionIds: Array.from(staleSessionIds),
            },
            errorCode: latestRun?.errorCode || "RUNNING_WITHOUT_SESSION",
            errorSource: latestRun?.errorSource || "worker_preflight",
            retryable: true,
            currentRunId: staleRunId,
            sessionId: null,
            finishAt: now,
            phaseFinishedAt: now,
          });
        } catch (error) {
          this.logger.warn("[worker] failed to recover stale running story", {
            event: "anomaly",
            runId: runId || null,
            storyId,
            prdId: staleStory.prdId || task.prdId || null,
            phase: staleStory.phase || task.phase || null,
            attempt: staleStory.attempt || task.attempt || null,
            traceId: staleStory.traceId || task.traceId || null,
            error: error?.message || String(error),
          });
        }
      }
      this.logger.warn("[worker] recovered stale running sessions", {
        event: "recover_stale_sessions",
        runId: runId || null,
        storyId,
        prdId: task.prdId || null,
        phase: task.phase || null,
        attempt: task.attempt || null,
        traceId: task.traceId || null,
        recoveredSessionIds: staleSessions.map((s) => s.id),
      });
    }

    const liveExisting = this.store
      .listSessions({ storyId, status: "running" })
      .filter((session) => this.sessionPool.isSessionActive(session.id));
    if (liveExisting.length > 0) {
      const story = this.store.getStory(storyId);
      this.logger.info("[worker] skipped duplicated running story", {
        event: "skip",
        runId: runId || null,
        storyId,
        prdId: story?.prdId || null,
        phase: story?.phase || null,
        attempt: task.attempt || story?.attempt || null,
        traceId: task.traceId || story?.traceId || null,
        reason: "already_running_session",
      });
      return;
    }

    // 更新 story: queued → running
    const story = this.store.getStory(storyId);
    if (!story) {
      this.logger.warn("[worker] skipped story not found in store", {
        event: "skip",
        runId: runId || null,
        storyId,
        prdId: task.prdId || null,
        phase: task.phase || null,
        attempt: task.attempt || null,
        traceId: task.traceId || null,
        reason: "story_not_found",
      });
      return;
    }
    if (story.status !== "queued") {
      this.logger.info("[worker] skipped story due to unexpected status", {
        event: "skip",
        runId: runId || null,
        storyId,
        prdId: story.prdId || task.prdId || null,
        phase: story.phase || task.phase || null,
        attempt: task.attempt || story.attempt || null,
        traceId: task.traceId || story.traceId || null,
        reason: "unexpected_story_status",
        currentStatus: story.status,
        expectedStatus: "queued",
      });
      return;
    }

    const run = this.store.getRun(runId);
    if (!run) {
      throw new Error(`run not found: ${runId}`);
    }
    if (run.status !== "queued") {
      this.logger.info("[worker] skipped run due to unexpected status", {
        event: "skip",
        runId,
        storyId,
        prdId: story.prdId || task.prdId || null,
        phase: story.phase || task.phase || null,
        attempt: task.attempt || story.attempt || null,
        traceId: task.traceId || story.traceId || null,
        reason: "unexpected_run_status",
        currentStatus: run.status,
        expectedStatus: "queued",
      });
      return;
    }
    const effectiveProjectId = story.projectId || task.projectId || run.projectId || null;

    const preflight = this._preflightStoryContext(task, story);
    if (!preflight.ok) {
      const failedAt = nowEast8Iso();
      const message = preflight.message;
      this.store.setRun({
        ...run,
        projectId: run.projectId || effectiveProjectId,
        status: "fail",
        finishAt: failedAt,
        exitCode: null,
        error: message,
        errorCode: preflight.code,
        errorSource: "worker_preflight",
      });
      this.store.transitionStory(story.id, "failed", {
        error: message,
        lastError: message,
        errorDetail: preflight.detail || null,
        errorCode: preflight.code,
        errorSource: "worker_preflight",
        retryable: false,
        finishAt: failedAt,
        phaseFinishedAt: failedAt,
        currentRunId: runId,
      });
      this.logger.warn("[worker] story blocked by context preflight", {
        event: "fail",
        runId,
        storyId,
        prdId: story.prdId || task.prdId || null,
        phase: story.phase || task.phase || null,
        attempt: task.attempt || story.attempt || null,
        traceId: task.traceId || story.traceId || null,
        error: message,
        errorCode: preflight.code,
      });
      return;
    }

    // 并发检查（仅针对真正可执行的 queued story，避免误计失败/重试）
    if (this.sessionPool.size >= this.config.maxConcurrency) {
      throw new WorkerBackpressureError(`concurrency limit reached (${this.config.maxConcurrency})`);
    }
    const projectConcurrencyLimit = this._normalizePositiveInt(this.config.maxConcurrencyPerProject);
    if (projectConcurrencyLimit) {
      const projectActiveCount = typeof this.sessionPool.getActiveCountByProject === "function"
        ? this.sessionPool.getActiveCountByProject(effectiveProjectId)
        : this.store.listSessions({ status: "running" }).filter((session) => {
          const sessionProjectId = session?.projectId || null;
          return sessionProjectId === effectiveProjectId;
        }).length;
      if (projectActiveCount >= projectConcurrencyLimit) {
        throw new WorkerBackpressureError(
          `project concurrency limit reached (project=${effectiveProjectId || "_default"} `
          + `${projectActiveCount}/${projectConcurrencyLimit})`,
        );
      }
    }

    const startedAt = nowEast8Iso();
    const runningStory = this.store.transitionStory(storyId, "running", {
      startedAt,
      startAt: startedAt,
      attempt: task.attempt || story.attempt || 1,
      maxAttempts: task.maxAttempts || story.maxAttempts || this.config.maxAttempts,
      traceId: task.traceId || story.traceId || null,
      currentRunId: runId,
    });

    // 创建 session 并 launch
    const session = {
      id: `ses-${crypto.randomUUID().slice(0, 8)}`,
      runId,
      storyId: task.storyId,
      prdId: task.prdId,
      projectId: effectiveProjectId,
      phase: task.phase,
      status: "running",
      traceId: task.traceId || runningStory.traceId || null,
      worktreePath: task.worktreePath,
      tool: task.tool,
      attempt: task.attempt,
      timeoutMs: task.timeoutMs,
      inactivityTimeoutMs: task.inactivityTimeoutMs ?? null,
      dispatchAt: task.dispatchAt || runningStory.dispatchAt || null,
      pid: null,
      exitCode: null,
      error: null,
      createdAt: nowEast8Iso(),
      startedAt: nowEast8Iso(),
      finishedAt: null,
    };

    this.store.setSession(session);
    this.store.setRun({
      ...run,
      projectId: run.projectId || effectiveProjectId,
      status: "running",
      startAt: startedAt,
      sessionId: session.id,
      traceId: session.traceId,
    });
    this.store.setStory({
      ...runningStory,
      status: "running",
      projectId: runningStory.projectId || effectiveProjectId,
      sessionId: session.id,
      traceId: session.traceId,
      startAt: startedAt,
      dispatchAt: task.dispatchAt || runningStory.dispatchAt || null,
      currentRunId: runId,
    });

    this.logger.info("[worker] story execution started", {
      event: "start",
      runId,
      storyId: task.storyId || null,
      prdId: task.prdId || null,
      phase: task.phase || null,
      attempt: task.attempt || runningStory.attempt || 1,
      traceId: session.traceId,
    });

    await this.sessionPool.launch(session, task);
    this.logger.info(`[worker] ${storyId}: session ${session.id} launched (phase=${task.phase})`);
  }

  _preflightStoryContext(task, story) {
    const worktreePath = task.worktreePath;
    if (!worktreePath) {
      return {
        ok: false,
        code: "WORKTREE_PATH_MISSING",
        message: "task missing worktreePath for story context validation",
        detail: { storyId: story.id, prdId: story.prdId || task.prdId || null },
      };
    }

    const prdFile = path.join(worktreePath, ".aha-loop", "prd.json");
    if (!fs.existsSync(prdFile)) {
      return {
        ok: false,
        code: "STORY_CONTEXT_FILE_MISSING",
        message: `missing story context file: ${prdFile}`,
        detail: { storyId: story.id, prdId: story.prdId || task.prdId || null, prdFile },
      };
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(prdFile, "utf8"));
    } catch (error) {
      return {
        ok: false,
        code: "STORY_CONTEXT_INVALID_JSON",
        message: `invalid story context file: ${prdFile}`,
        detail: {
          storyId: story.id,
          prdId: story.prdId || task.prdId || null,
          prdFile,
          parseError: error?.message || String(error),
        },
      };
    }

    const expectedPrdId = story.prdId || task.prdId || null;
    const expectedProjectId = story.projectId || task.projectId || null;
    if (expectedPrdId && data?.prdId && data.prdId !== expectedPrdId) {
      return {
        ok: false,
        code: "STORY_CONTEXT_PRD_MISMATCH",
        message: `story context prd mismatch: expected ${expectedPrdId}, got ${data.prdId}`,
        detail: {
          storyId: story.id,
          expectedPrdId,
          actualPrdId: data.prdId,
          prdFile,
        },
      };
    }

    if (expectedProjectId && data?.projectId && data.projectId !== expectedProjectId) {
      return {
        ok: false,
        code: "STORY_CONTEXT_PROJECT_MISMATCH",
        message: `story context project mismatch: expected ${expectedProjectId}, got ${data.projectId}`,
        detail: {
          storyId: story.id,
          expectedProjectId,
          actualProjectId: data.projectId,
          prdFile,
        },
      };
    }

    const stories = Array.isArray(data?.stories) ? data.stories : [];
    if (stories.length === 0) {
      return {
        ok: false,
        code: "STORY_CONTEXT_STORIES_MISSING",
        message: `story context missing stories definition for ${story.id}`,
        detail: {
          storyId: story.id,
          expectedPrdId,
          actualPrdId: data?.prdId || null,
          prdFile,
        },
      };
    }

    const hasStory = stories.some((item) => {
      if (typeof item === "string") return item === story.id;
      if (!item || typeof item !== "object") return false;
      return item.id === story.id || item.storyId === story.id;
    });

    if (!hasStory) {
      return {
        ok: false,
        code: "STORY_CONTEXT_STORY_NOT_FOUND",
        message: `story context not found for ${story.id} in ${prdFile}`,
        detail: {
          storyId: story.id,
          expectedPrdId,
          actualPrdId: data?.prdId || null,
          prdFile,
        },
      };
    }

    this._writeRuntimeStoryContextSnapshot({
      worktreePath,
      sourcePrdId: data?.prdId || null,
      sourceProjectId: data?.projectId || null,
      story,
      task,
    });

    return { ok: true };
  }

  _writeRuntimeStoryContextSnapshot({ worktreePath, sourcePrdId, sourceProjectId, story, task }) {
    const desiredAttempt = this._normalizePositiveInt(task.attempt ?? story.attempt);
    const desiredMaxAttempts = this._normalizePositiveInt(task.maxAttempts ?? story.maxAttempts);
    const snapshot = {
      storyId: story.id,
      prdId: story.prdId || task.prdId || sourcePrdId || null,
      projectId: story.projectId || task.projectId || sourceProjectId || null,
      status: story.status || null,
      phase: story.phase || task.phase || null,
      attempt: desiredAttempt,
      maxAttempts: desiredMaxAttempts,
      traceId: task.traceId || story.traceId || null,
      updatedAt: nowEast8Iso(),
    };

    const runtimeDir = path.join(worktreePath, ".aha-loop", "runtime");
    const runtimeFile = path.join(runtimeDir, "story-context.json");
    let runtimeData = {
      version: 1,
      updatedAt: nowEast8Iso(),
      prdId: snapshot.prdId,
      projectId: snapshot.projectId,
      stories: {},
    };

    try {
      if (fs.existsSync(runtimeFile)) {
        const loaded = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
        if (loaded && typeof loaded === "object") {
          runtimeData = {
            version: loaded.version || 1,
            updatedAt: loaded.updatedAt || nowEast8Iso(),
            prdId: loaded.prdId || snapshot.prdId,
            projectId: loaded.projectId || snapshot.projectId,
            stories: loaded.stories && typeof loaded.stories === "object" ? loaded.stories : {},
          };
        }
      }
    } catch (error) {
      this.logger.warn("[worker] runtime context load failed, fallback to fresh snapshot", {
        event: "anomaly",
        storyId: story.id || null,
        prdId: snapshot.prdId || null,
        phase: snapshot.phase || null,
        attempt: snapshot.attempt || null,
        traceId: snapshot.traceId || null,
        runtimeFile,
        error: error?.message || String(error),
      });
      runtimeData = {
        version: 1,
        updatedAt: nowEast8Iso(),
        prdId: snapshot.prdId,
        projectId: snapshot.projectId,
        stories: {},
      };
    }

    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      runtimeData.updatedAt = nowEast8Iso();
      runtimeData.prdId = runtimeData.prdId || snapshot.prdId;
      runtimeData.projectId = runtimeData.projectId || snapshot.projectId;
      runtimeData.stories[story.id] = {
        ...(runtimeData.stories[story.id] || {}),
        ...snapshot,
      };

      fs.writeFileSync(runtimeFile, `${JSON.stringify(runtimeData, null, 2)}\n`, "utf8");
      this.logger.info("[worker] story context synchronized", {
        event: "story_context_sync",
        storyId: story.id || null,
        prdId: snapshot.prdId || null,
        phase: snapshot.phase || null,
        attempt: snapshot.attempt || null,
        traceId: snapshot.traceId || null,
        runtimeFile,
      });
    } catch (error) {
      this.logger.warn("[worker] story context sync failed", {
        event: "anomaly",
        storyId: story.id || null,
        prdId: snapshot.prdId || null,
        phase: snapshot.phase || null,
        attempt: snapshot.attempt || null,
        traceId: snapshot.traceId || null,
        runtimeFile,
        error: error?.message || String(error),
      });
    }
  }

  _normalizePositiveInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  }
}

module.exports = { Worker };
