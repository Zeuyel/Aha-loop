"use strict";

const { PhaseEngine, parsePhaseResultFromOutput } = require("./phase-engine");
const { nowEast8Iso, toEast8Iso } = require("../core/time");

function normalizeFailure(error, defaults = {}) {
  if (error == null) {
    return {
      code: defaults.code || "UNKNOWN_ERROR",
      source: defaults.source || "session_pool",
      message: defaults.message || "unknown error",
    };
  }

  if (typeof error === "string") {
    return {
      code: defaults.code || "SESSION_ERROR",
      source: defaults.source || "session_pool",
      message: error,
    };
  }

  if (error instanceof Error) {
    return {
      code: error.code || defaults.code || "SESSION_EXCEPTION",
      source: defaults.source || "session_pool",
      message: error.message || String(error),
      stack: error.stack || null,
      retryable: error.retryable,
    };
  }

  if (typeof error === "object") {
    return {
      code: error.code || defaults.code || "SESSION_ERROR",
      source: error.source || defaults.source || "session_pool",
      message: typeof error.message === "string" ? error.message : (defaults.message || "session error"),
      ...error,
    };
  }

  return {
    code: defaults.code || "SESSION_ERROR",
    source: defaults.source || "session_pool",
    message: String(error),
  };
}

function errorMessage(error) {
  if (error == null) return null;
  if (typeof error === "string") return error;
  if (typeof error?.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

const SEMANTIC_FAILURE_PATTERNS = [
  /(^|\n)\s*错误\s*[:：]/i,
  /(^|\n)\s*错误原因\s*[:：]/i,
  /无法继续执行/,
  /无法在不.*前提下.*(?:完成|继续)/,
  /请提供以下任一信息后我可继续执行/,
  /(^|\n)\s*(error|failure)\s*:/i,
  /unable to continue/i,
  /cannot continue/i,
];

const SEMANTIC_RETRYABLE_PATTERNS = [
  /请确认你希望我如何继续/,
  /请确认你希望我基于哪份/,
  /请提供以下任一信息后我可继续执行/,
  /先由你处理这些现有变更后/,
  /存在我未创建的变更/,
  /非本次会话产生的变更/,
  /please confirm/i,
  /please provide/i,
];

function detectSemanticFailureFromOutput(output) {
  const stdout = typeof output?.stdout === "string" ? output.stdout : "";
  const normalized = stdout.trim();
  if (!normalized) return null;

  const head = normalized.slice(0, 3_000);
  const matched = SEMANTIC_FAILURE_PATTERNS.find((pattern) => pattern.test(head));
  if (!matched) return null;

  const lines = head
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstSignalLine = lines.find((line) => matched.test(line)) || lines[0] || "semantic failure in stdout";
  const retryable = SEMANTIC_RETRYABLE_PATTERNS.some((pattern) => pattern.test(head));

  return {
    code: "PHASE_SEMANTIC_FAILURE",
    source: "session_pool",
    message: `semantic failure signal detected in stdout: ${firstSignalLine.slice(0, 240)}`,
    signalLine: firstSignalLine,
    retryable,
  };
}

function normalizeAcceptanceCriteria(criteria) {
  if (!Array.isArray(criteria)) return [];
  return criteria
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeAcceptanceStatus(rawStatus) {
  if (typeof rawStatus === "boolean") return rawStatus ? "pass" : "failed";
  const value = String(rawStatus || "").trim().toLowerCase();
  if (["pass", "passed", "ok", "success", "met", "done", "true"].includes(value)) return "pass";
  if (["failed", "fail", "error", "blocked", "missing", "false"].includes(value)) return "failed";
  return null;
}

function normalizeAcceptanceCheckItem(item, idx, fallbackId = null) {
  const defaultId = String(fallbackId || `AC${idx + 1}`).trim() || `AC${idx + 1}`;
  if (!item || typeof item !== "object") {
    return {
      id: defaultId,
      status: null,
      passed: false,
      evidence: String(item || "").trim(),
      hasIdentifier: Boolean(fallbackId),
      hasStatus: false,
      valid: false,
    };
  }

  const rawId = String(item.id || item.key || item.name || "").trim();
  const index = Number(item.index);
  const hasIndex = Number.isInteger(index) && index >= 0;
  const hasIdentifier = rawId.length > 0 || hasIndex || Boolean(fallbackId);
  const id = rawId || (hasIndex ? `AC${index + 1}` : defaultId);
  const status = normalizeAcceptanceStatus(
    item.status ?? item.result ?? item.outcome ?? item.passed ?? item.pass,
  );
  const hasStatus = status !== null;

  return {
    id,
    status,
    passed: status === "pass",
    evidence: String(item.evidence || item.message || item.summary || item.reason || "").trim(),
    hasIdentifier,
    hasStatus,
    valid: hasIdentifier && hasStatus,
  };
}

function collectAcceptanceChecks(phaseResult) {
  if (!phaseResult || typeof phaseResult !== "object") return [];
  const artifacts = phaseResult.artifacts && typeof phaseResult.artifacts === "object"
    ? phaseResult.artifacts
    : {};
  const candidates = [
    artifacts.acceptanceCriteriaChecks,
    artifacts.acceptanceCriteriaCheck,
    artifacts.acceptanceCriteria,
    artifacts.criteriaCheck,
    artifacts.criteria,
    phaseResult.acceptanceCriteriaChecks,
    phaseResult.acceptanceCriteriaCheck,
    phaseResult.acceptanceCriteria,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (Array.isArray(candidate)) {
      return candidate.map((item, idx) => normalizeAcceptanceCheckItem(item, idx));
    }

    if (candidate && typeof candidate === "object") {
      const entries = Object.entries(candidate);
      if (entries.length === 0) continue;
      return entries.map(([key, value], idx) => normalizeAcceptanceCheckItem(value, idx, key));
    }
  }

  return [];
}

function validateAcceptanceCriteriaEvidence(task, phaseResult) {
  const acceptanceCriteria = normalizeAcceptanceCriteria(task?.acceptanceCriteria);
  if (acceptanceCriteria.length === 0) return null;

  if (!phaseResult || typeof phaseResult !== "object") {
    return {
      code: "PHASE_ACCEPTANCE_EVIDENCE_MISSING",
      source: "phase_contract",
      message: "story with acceptanceCriteria requires structured phaseResult evidence",
      retryable: false,
      expectedCount: acceptanceCriteria.length,
      actualCount: 0,
    };
  }

  if (String(phaseResult.status || "").trim().toLowerCase() !== "success") {
    return {
      code: "PHASE_ACCEPTANCE_EVIDENCE_MISSING",
      source: "phase_contract",
      message: "phaseResult.status must be success when acceptanceCriteria exists",
      retryable: false,
      expectedCount: acceptanceCriteria.length,
      actualCount: 0,
    };
  }

  const checks = collectAcceptanceChecks(phaseResult);
  if (checks.length === 0) {
    return {
      code: "PHASE_ACCEPTANCE_EVIDENCE_MISSING",
      source: "phase_contract",
      message: "phaseResult.artifacts.acceptanceCriteriaChecks is required when acceptanceCriteria exists",
      retryable: false,
      expectedCount: acceptanceCriteria.length,
      actualCount: 0,
    };
  }

  const missing = [];
  const failed = [];
  const invalid = [];

  for (let idx = 0; idx < acceptanceCriteria.length; idx += 1) {
    const check = checks[idx];
    if (!check) {
      missing.push(`AC${idx + 1}`);
      continue;
    }
    if (!check.valid) {
      invalid.push(check.id || `AC${idx + 1}`);
      continue;
    }
    if (check.passed !== true) {
      failed.push(check.id || `AC${idx + 1}`);
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    return {
      code: "PHASE_ACCEPTANCE_EVIDENCE_INCOMPLETE",
      source: "phase_contract",
      message: `acceptance criteria evidence incomplete (missing=${missing.join(",") || "none"}, invalid=${invalid.join(",") || "none"})`,
      retryable: false,
      expectedCount: acceptanceCriteria.length,
      actualCount: checks.length,
      missingChecks: missing,
      invalidChecks: invalid,
      failedChecks: failed,
    };
  }

  if (failed.length > 0) {
    return {
      code: "PHASE_ACCEPTANCE_CHECKS_FAILED",
      source: "phase_contract",
      message: `acceptance criteria checks failed: ${failed.join(",")}`,
      retryable: true,
      expectedCount: acceptanceCriteria.length,
      actualCount: checks.length,
      missingChecks: missing,
      failedChecks: failed,
    };
  }

  return null;
}

/**
 * SessionPool — 管理所有 spawn 出来的 AI agent 子进程
 * 职责: spawn / poll(存活+超时) / kill / 收集输出 / 上报结果
 */
class SessionPool {
  constructor(config, store, eventBus, logger = console) {
    this.config = config;
    this.store = store;
    this.eventBus = eventBus;
    this.logger = logger;

    this.phaseEngine = new PhaseEngine(config, logger);
    this._active = new Map(); // sessionId -> { session, cancel, startedAt, timeoutMs, inactivityTimeoutMs, getStats, done }
    this._pollTimer = null;
  }

  get size() { return this._active.size; }

  isSessionActive(sessionId) {
    if (!sessionId) return false;
    return this._active.has(sessionId);
  }

  start() {
    this._pollTimer = setInterval(() => this._pollAll(), this.config.sessionPollMs);
    this.logger.info(`[session-pool] started (poll every ${this.config.sessionPollMs}ms)`);
  }

  async stop() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    const waits = [];
    for (const [, entry] of this._active) {
      try { entry.cancel("shutdown"); } catch {}
      if (entry.done && typeof entry.done.then === "function") {
        waits.push(entry.done.catch(() => {}));
      }
    }
    if (waits.length > 0) {
      await Promise.race([
        Promise.allSettled(waits),
        new Promise((resolve) => setTimeout(resolve, 6_500)),
      ]);
    }
    this.logger.info("[session-pool] stopped");
  }

  /**
   * 启动一个阶段执行任务（Node 内嵌执行引擎）
   * @param {Object} session - session 实体
   * @param {Object} task - 任务消息 (包含 tool, worktreePath, phase 等)
   */
  async launch(session, task) {
    if (this.config.dryRun) {
      this.logger.info(`[session-pool] DRY-RUN: story=${task.storyId} phase=${task.phase}`);
      session.status = "completed";
      session.exitCode = 0;
      session.finishedAt = nowEast8Iso();
      session.finishAt = session.finishedAt;
      this.store.setSession(session);
      if (session.runId) {
        const run = this.store.getRun(session.runId);
        if (run) {
          this.store.setRun({
            ...run,
            status: "success",
            sessionId: session.id,
            startAt: run.startAt || session.startedAt || session.startAt || nowEast8Iso(),
            finishAt: session.finishedAt,
            exitCode: 0,
            error: null,
            errorCode: null,
            errorSource: null,
          });
        }
      }
      try {
        this.store.transitionStory(session.storyId, "phase_done");
      } catch (e) {
        this.logger.error(`[session-pool] dry-run transition error: ${e.message}`);
      }
      this.logger.info("[session-pool] story phase completed (dry-run)", {
        event: "success",
        runId: session.runId || null,
        storyId: session.storyId || null,
        prdId: session.prdId || null,
        phase: session.phase || null,
        attempt: session.attempt || null,
        traceId: session.traceId || null,
      });
      this.eventBus.fire("session:completed", { sessionId: session.id, storyId: session.storyId, exitCode: 0 });
      return;
    }

    const startedAt = Date.now();
    const timeoutMs = normalizeTimeoutMs(task.timeoutMs ?? this.config.storyTimeoutMs);
    const inactivityTimeoutMs = normalizeTimeoutMs(task.inactivityTimeoutMs ?? this.config.storyInactivityTimeoutMs);
    let finalized = false;
    let cancellation = null;

    const runner = this.phaseEngine.start(task);
    const initialStats = runner.getStats ? runner.getStats() : null;
    session.pid = runner.pid || null;
    session.execution = {
      command: runner.command?.cmd || null,
      argsPreview: this._argsPreview(runner.command?.args || []),
      cwd: runner.command?.cwd || task.worktreePath || task.workspacePath || process.cwd(),
      startedAt: nowEast8Iso(),
      pid: runner.pid || null,
      lastOutputAt: initialStats?.lastOutputAt || nowEast8Iso(),
      lastOutputAtMs: initialStats?.lastOutputAtMs ?? startedAt,
      stdoutBytes: initialStats?.stdoutBytes ?? 0,
      stderrBytes: initialStats?.stderrBytes ?? 0,
    };
    this.store.setSession(session);

    const requestCancel = (reason = "cancelled", details = null) => {
      if (finalized) return false;
      if (!cancellation) {
        cancellation = {
          reason,
          requestedAt: Date.now(),
          details: details && typeof details === "object" ? { ...details } : null,
        };
      }
      try { runner.cancel(reason); } catch {}
      return true;
    };

    const completion = runner.wait();
    this._active.set(session.id, {
      session,
      startedAt,
      timeoutMs,
      inactivityTimeoutMs,
      cancel: requestCancel,
      getOutput: () => runner.getOutput(),
      getStats: () => (runner.getStats ? runner.getStats() : null),
      isCancelling: () => Boolean(cancellation),
      done: completion,
    });

    this.logger.info(
      `[session-pool] run: story=${task.storyId} phase=${task.phase} tool=${task.tool || this.config.defaultTool} hardTimeout=${timeoutMs ?? "off"} idleTimeout=${inactivityTimeoutMs ?? "off"}`,
    );

    try {
      const result = await completion;
      if (finalized) return;
      finalized = true;

      session.pid = session.pid || result.pid || null;
      session.execution = {
        ...(session.execution || {}),
        finishedAt: result.finishedAt || nowEast8Iso(),
        durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
        signal: result.signal || null,
        cancelled: Boolean(result.cancelled),
        cancelReason: result.cancelReason || cancellation?.reason || null,
        lastOutputAt: result.lastOutputAt || session.execution?.lastOutputAt || null,
        lastOutputAtMs: Number.isFinite(result.lastOutputAtMs) ? result.lastOutputAtMs : (session.execution?.lastOutputAtMs ?? null),
        stdoutBytes: Number.isFinite(result.stdoutBytes) ? result.stdoutBytes : (session.execution?.stdoutBytes ?? null),
        stderrBytes: Number.isFinite(result.stderrBytes) ? result.stderrBytes : (session.execution?.stderrBytes ?? null),
      };
      this.store.setSession(session);

      const output = { stdout: result.stdout || "", stderr: result.stderr || "" };
      if (cancellation) {
        const failure = this._buildCancellationFailure(cancellation.reason, {
          timeoutMs,
          inactivityTimeoutMs,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          result,
          details: cancellation.details,
        });
        this._finalize(session.id, {
          exitCode: result.exitCode ?? null,
          error: failure,
          retryable: this._isRetryableCancellation(cancellation.reason),
          output,
        });
        return;
      }

      const phaseResult = result.phaseResult || parsePhaseResultFromOutput(output);
      if (phaseResult) {
        if (phaseResult.status === "failed") {
          const contractFailure = {
            code: phaseResult.code || "PHASE_RESULT_FAILED",
            source: "phase_contract",
            message: phaseResult.message || "phase reported failed via structured contract",
            retryable: phaseResult.retryable !== false,
            nextAction: phaseResult.nextAction || null,
            artifacts: phaseResult.artifacts || {},
          };
          this.logger.warn("[session-pool] structured phase failure received", {
            event: "phase_contract_fail",
            runId: session.runId || null,
            storyId: session.storyId || null,
            prdId: session.prdId || null,
            phase: session.phase || null,
            attempt: session.attempt || null,
            traceId: session.traceId || null,
            errorCode: contractFailure.code,
          });
          this._finalize(session.id, {
            exitCode: result.exitCode,
            error: contractFailure,
            retryable: contractFailure.retryable,
            output,
            phaseResult,
          });
          return;
        }

        const acceptanceCriteriaFailure = validateAcceptanceCriteriaEvidence(task, phaseResult);
        if (acceptanceCriteriaFailure) {
          this.logger.warn("[session-pool] acceptance criteria gate rejected phase result", {
            event: "ac_gate_reject",
            runId: session.runId || null,
            storyId: session.storyId || null,
            prdId: session.prdId || null,
            phase: session.phase || null,
            attempt: session.attempt || null,
            traceId: session.traceId || null,
            errorCode: acceptanceCriteriaFailure.code,
            error: acceptanceCriteriaFailure.message,
            missingChecks: acceptanceCriteriaFailure.missingChecks || [],
            invalidChecks: acceptanceCriteriaFailure.invalidChecks || [],
            failedChecks: acceptanceCriteriaFailure.failedChecks || [],
          });
          this._finalize(session.id, {
            exitCode: result.exitCode,
            error: acceptanceCriteriaFailure,
            retryable: acceptanceCriteriaFailure.retryable !== false,
            output,
            phaseResult,
          });
          return;
        }

        this._finalize(session.id, {
          exitCode: 0,
          error: null,
          output,
          phaseResult,
        });
        return;
      }

      const acceptanceCriteriaFailure = validateAcceptanceCriteriaEvidence(task, null);
      if (acceptanceCriteriaFailure) {
        this.logger.warn("[session-pool] acceptance criteria gate rejected unstructured success output", {
          event: "ac_gate_missing_contract",
          runId: session.runId || null,
          storyId: session.storyId || null,
          prdId: session.prdId || null,
          phase: session.phase || null,
          attempt: session.attempt || null,
          traceId: session.traceId || null,
          errorCode: acceptanceCriteriaFailure.code,
          error: acceptanceCriteriaFailure.message,
        });
        this._finalize(session.id, {
          exitCode: result.exitCode,
          error: acceptanceCriteriaFailure,
          retryable: acceptanceCriteriaFailure.retryable !== false,
          output,
          phaseResult: null,
        });
        return;
      }

      if (result.exitCode === 0) {
        const semanticFailure = detectSemanticFailureFromOutput(output);
        if (semanticFailure) {
          this.logger.warn("[session-pool] semantic failure detected despite zero exit code", {
            event: "semantic_fail",
            runId: session.runId || null,
            storyId: session.storyId || null,
            prdId: session.prdId || null,
            phase: session.phase || null,
            attempt: session.attempt || null,
            traceId: session.traceId || null,
            signalLine: semanticFailure.signalLine,
          });
          this._finalize(session.id, {
            exitCode: result.exitCode,
            error: semanticFailure,
            retryable: semanticFailure.retryable !== false,
            output,
            phaseResult: null,
          });
          return;
        }

        this._finalize(session.id, {
          exitCode: 0,
          error: null,
          output,
          phaseResult: null,
        });
        return;
      }

      const failure = {
        code: "PHASE_EXEC_FAILED",
        source: "phase_engine",
        message: `story=${task.storyId} phase=${result.phase || task.phase} 执行失败: exit=${result.exitCode}`,
        exitCode: result.exitCode,
        signal: result.signal || null,
        pid: result.pid || session.pid || null,
      };
      this._finalize(session.id, {
        exitCode: result.exitCode,
        error: failure,
        retryable: true,
        output,
        phaseResult: null,
      });
    } catch (err) {
      if (finalized) return;
      finalized = true;

      const partial = runner.getOutput ? runner.getOutput() : { stdout: "", stderr: "" };
      const partialStats = runner.getStats ? runner.getStats() : null;
      session.execution = {
        ...(session.execution || {}),
        finishedAt: nowEast8Iso(),
        cancelReason: cancellation?.reason || null,
        lastOutputAt: partialStats?.lastOutputAt || session.execution?.lastOutputAt || null,
        lastOutputAtMs: Number.isFinite(partialStats?.lastOutputAtMs) ? partialStats.lastOutputAtMs : (session.execution?.lastOutputAtMs ?? null),
        stdoutBytes: Number.isFinite(partialStats?.stdoutBytes) ? partialStats.stdoutBytes : (session.execution?.stdoutBytes ?? null),
        stderrBytes: Number.isFinite(partialStats?.stderrBytes) ? partialStats.stderrBytes : (session.execution?.stderrBytes ?? null),
      };
      this.store.setSession(session);

      if (cancellation) {
        const failure = this._buildCancellationFailure(cancellation.reason, {
          timeoutMs,
          inactivityTimeoutMs,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          error: err,
          details: cancellation.details,
        });
        this._finalize(session.id, {
          exitCode: null,
          error: failure,
          retryable: this._isRetryableCancellation(cancellation.reason),
          output: partial,
          phaseResult: null,
        });
        return;
      }

      const retryable = err && err.retryable !== false;
      const failure = normalizeFailure(err, {
        code: "PHASE_EXEC_FAILURE",
        source: "phase_engine",
      });
      this._finalize(session.id, {
        exitCode: -1,
        error: failure,
        retryable,
        output: {
          stdout: partial.stdout || "",
          stderr: partial.stderr || String(err?.stack || err?.message || "unknown error"),
        },
        phaseResult: null,
      });
    }
  }

  /** 标记取消指定 session */
  kill(sessionId) {
    const entry = this._active.get(sessionId);
    if (!entry) return false;
    try { return entry.cancel("killed") !== false; } catch { return false; }
  }

  /** 获取 session 输出（持久化后从 store 读） */
  getOutput(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) return { stdout: "", stderr: "" };
    return {
      stdout: session.output?.stdout || "",
      stderr: session.output?.stderr || "",
    };
  }

  /** 轮询所有活跃 session */
  _pollAll() {
    const now = Date.now();
    for (const [id, entry] of this._active) {
      const stats = entry.getStats ? entry.getStats() : null;
      if (stats) {
        const execution = entry.session.execution || {};
        const nextExecution = {
          ...execution,
          lastOutputAt: stats.lastOutputAt || execution.lastOutputAt || null,
          lastOutputAtMs: Number.isFinite(stats.lastOutputAtMs) ? stats.lastOutputAtMs : (execution.lastOutputAtMs ?? null),
          stdoutBytes: Number.isFinite(stats.stdoutBytes) ? stats.stdoutBytes : (execution.stdoutBytes ?? null),
          stderrBytes: Number.isFinite(stats.stderrBytes) ? stats.stderrBytes : (execution.stderrBytes ?? null),
        };
        if (
          execution.lastOutputAtMs !== nextExecution.lastOutputAtMs
          || execution.stdoutBytes !== nextExecution.stdoutBytes
          || execution.stderrBytes !== nextExecution.stderrBytes
        ) {
          entry.session.execution = nextExecution;
          this.store.setSession(entry.session);
        }
      }

      if (entry.isCancelling && entry.isCancelling()) continue;

      const age = now - entry.startedAt;

      if (Number.isFinite(entry.inactivityTimeoutMs) && entry.inactivityTimeoutMs > 0) {
        const lastOutputAtMs = Number.isFinite(stats?.lastOutputAtMs) ? stats.lastOutputAtMs : entry.startedAt;
        const idleMs = now - lastOutputAtMs;
        if (idleMs > entry.inactivityTimeoutMs) {
          this.logger.warn(`[session-pool] ${id}: idle timeout (${idleMs}ms > ${entry.inactivityTimeoutMs}ms)`);
          try {
            entry.cancel("idle_timeout", {
              inactivityTimeoutMs: entry.inactivityTimeoutMs,
              idleMs,
              lastOutputAtMs,
              lastOutputAt: toEast8Iso(lastOutputAtMs),
            });
          } catch {}
          continue;
        }
      }

      if (Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0 && age > entry.timeoutMs) {
        this.logger.warn(`[session-pool] ${id}: hard timeout (${age}ms > ${entry.timeoutMs}ms)`);
        try { entry.cancel("timeout", { timeoutMs: entry.timeoutMs, elapsedMs: age }); } catch {}
      }
    }
  }

  _isRetryableCancellation(reason) {
    const key = String(reason || "").toLowerCase();
    if (key === "killed") return false;
    return true;
  }

  _buildCancellationFailure(
    reason,
    { timeoutMs, inactivityTimeoutMs, elapsedMs, details = null, result = null, error = null } = {},
  ) {
    const key = String(reason || "cancelled").toLowerCase();
    if (key === "timeout") {
      const effectiveTimeoutMs = Number.isFinite(details?.timeoutMs) ? details.timeoutMs : timeoutMs;
      const effectiveElapsedMs = Number.isFinite(details?.elapsedMs) ? details.elapsedMs : elapsedMs;
      return {
        code: "SESSION_TIMEOUT",
        source: "session_pool",
        message: `timeout after ${effectiveElapsedMs}ms (limit ${effectiveTimeoutMs}ms)`,
        reason: key,
        timeoutMs: effectiveTimeoutMs,
        elapsedMs: effectiveElapsedMs,
        pid: result?.pid || null,
        signal: result?.signal || null,
      };
    }
    if (key === "idle_timeout") {
      const effectiveInactivityTimeoutMs = Number.isFinite(details?.inactivityTimeoutMs)
        ? details.inactivityTimeoutMs
        : inactivityTimeoutMs;
      const effectiveIdleMs = Number.isFinite(details?.idleMs) ? details.idleMs : elapsedMs;
      return {
        code: "SESSION_IDLE_TIMEOUT",
        source: "session_pool",
        message: `no output for ${effectiveIdleMs}ms (limit ${effectiveInactivityTimeoutMs}ms)`,
        reason: key,
        inactivityTimeoutMs: effectiveInactivityTimeoutMs,
        idleMs: effectiveIdleMs,
        elapsedMs,
        lastOutputAt: details?.lastOutputAt || null,
        lastOutputAtMs: Number.isFinite(details?.lastOutputAtMs) ? details.lastOutputAtMs : null,
        pid: result?.pid || null,
        signal: result?.signal || null,
      };
    }
    if (key === "shutdown") {
      return {
        code: "SESSION_SHUTDOWN",
        source: "session_pool",
        message: "session cancelled during shutdown",
        reason: key,
        elapsedMs,
        pid: result?.pid || null,
        signal: result?.signal || null,
      };
    }
    if (key === "killed") {
      return {
        code: "SESSION_KILLED",
        source: "session_pool",
        message: "session killed by operator",
        reason: key,
        elapsedMs,
        pid: result?.pid || null,
        signal: result?.signal || null,
      };
    }

    return {
      code: "SESSION_CANCELLED",
      source: "session_pool",
      message: `session cancelled: ${key}`,
      reason: key,
      elapsedMs,
      pid: result?.pid || null,
      signal: result?.signal || null,
      cause: errorMessage(error),
    };
  }

  _argsPreview(args) {
    if (!Array.isArray(args) || args.length === 0) return [];
    return args.slice(0, 8).map((arg) => {
      const text = String(arg ?? "");
      if (text.length <= 160) return text;
      return `${text.slice(0, 157)}...`;
    });
  }

  /** 进程结束处理 */
  _finalize(sessionId, { exitCode, error, retryable = true, output = { stdout: "", stderr: "" }, phaseResult = null }) {
    const entry = this._active.get(sessionId);
    if (!entry) return;

    this._active.delete(sessionId);

    const session = entry.session;
    const success = exitCode === 0 && !error;
    const failureMessage = errorMessage(error);

    session.status = success ? "completed" : "failed";
    session.exitCode = exitCode;
    session.error = error;
    session.retryable = retryable;
    session.output = output;
    session.phaseResult = phaseResult;
    session.finishedAt = nowEast8Iso();
    session.finishAt = session.finishedAt;
    this.store.setSession(session);

    if (session.runId) {
      const run = this.store.getRun(session.runId);
      if (run) {
        const runStatus = String(run.status || "").toLowerCase();
        const keepControlState = !success && (runStatus === "cancelled" || runStatus === "restarted");
        if (keepControlState) {
          this.store.setRun({
            ...run,
            sessionId: run.sessionId || session.id,
            finishAt: run.finishAt || session.finishedAt,
            exitCode: run.exitCode ?? exitCode,
            phaseResult: run.phaseResult || phaseResult || null,
          });
        } else {
          this.store.setRun({
            ...run,
            status: success ? "success" : "fail",
            sessionId: session.id,
            startAt: run.startAt || session.startedAt || session.startAt || null,
            finishAt: session.finishedAt,
            exitCode,
            error: success ? null : failureMessage,
            errorCode: success ? null : (typeof error === "object" && error ? error.code || null : null),
            errorSource: success ? null : (typeof error === "object" && error ? error.source || null : null),
            phaseResult: phaseResult || null,
          });
        }
      }
    }

    const currentStory = session.storyId ? this.store.getStory(session.storyId) : null;
    const canTransition = currentStory && currentStory.status === "running";
    if (canTransition) {
      const targetStatus = success ? "phase_done" : "failed";
      try {
        this.store.transitionStory(session.storyId, targetStatus, {
          error: success ? null : failureMessage,
          lastError: success ? null : failureMessage,
          errorDetail: success ? null : (typeof error === "object" ? error : null),
          errorCode: success ? null : (typeof error === "object" && error ? error.code || null : null),
          errorSource: success ? null : (typeof error === "object" && error ? error.source || null : null),
          retryable,
          finishAt: session.finishedAt,
          phaseFinishedAt: session.finishedAt,
          finishedAt: success ? undefined : session.finishedAt,
          currentRunId: session.runId || null,
        });
      } catch (e) {
        this.logger.error(`[session-pool] ${sessionId}: transition error: ${e.message}`);
      }
    }

    const event = success ? "session:completed" : "session:failed";
    this.eventBus.fire(event, {
      sessionId,
      runId: session.runId || null,
      storyId: session.storyId,
      prdId: session.prdId,
      phase: session.phase,
      attempt: session.attempt,
      traceId: session.traceId,
      exitCode,
      error: success ? null : error,
      retryable,
      phaseResult: phaseResult || null,
    });

    if (success) {
      this.logger.info("[session-pool] story phase execution succeeded", {
        event: "success",
        runId: session.runId || null,
        storyId: session.storyId || null,
        prdId: session.prdId || null,
        phase: session.phase || null,
        attempt: session.attempt || null,
        traceId: session.traceId || null,
      });
    } else {
      this.logger.error("[session-pool] story phase execution failed", {
        event: "fail",
        runId: session.runId || null,
        storyId: session.storyId || null,
        prdId: session.prdId || null,
        phase: session.phase || null,
        attempt: session.attempt || null,
        traceId: session.traceId || null,
        error,
        retryable,
      });
    }
  }
}

module.exports = { SessionPool, detectSemanticFailureFromOutput, validateAcceptanceCriteriaEvidence };
