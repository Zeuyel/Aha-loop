"use strict";

const { spawnPortable } = require("../core/spawn-portable");
const { normalizeStoryPhase } = require("../store/schemas");
const { nowEast8Iso, toEast8Iso } = require("../core/time");

class PhaseExecutionError extends Error {
  constructor(message, { code = "PHASE_EXEC_ERROR", retryable = true } = {}) {
    super(message);
    this.name = "PhaseExecutionError";
    this.code = code;
    this.retryable = retryable;
  }
}

const PHASE_RESULT_PREFIX = "AHA_LOOP_PHASE_RESULT_JSON:";

class PhaseEngine {
  constructor(configOrLogger = null, logger = null) {
    if (configOrLogger && typeof configOrLogger.info === "function" && logger == null) {
      this.config = {};
      this.logger = configOrLogger;
      return;
    }

    this.config = (configOrLogger && typeof configOrLogger === "object") ? configOrLogger : {};
    this.logger = logger || console;
  }

  start(task) {
    const phase = normalizePhase(task.phase);
    const tool = (task.tool || "codex").toLowerCase();

    if (!phase) {
      throw new PhaseExecutionError("phase 不能为空", { code: "INVALID_PHASE", retryable: false });
    }

    const prompt = this._buildPrompt({ ...task, phase });
    const command = this._buildToolCommand(tool, prompt);
    const cwd = task.worktreePath || task.workspacePath || process.cwd();

    this.logger.info(`[phase-engine] start story=${task.storyId} phase=${phase} tool=${tool} run=${task.runId || "-"}`);

    const runner = runCommandControlled(command.cmd, command.args, cwd);
    return {
      phase,
      tool,
      command: { cmd: command.cmd, args: command.args, cwd },
      pid: runner.pid,
      cancel: (reason = "cancelled") => runner.cancel(reason),
      getOutput: () => runner.getOutput(),
      getStats: () => runner.getStats(),
      wait: async () => {
        const result = await runner.done;
        return {
          phase,
          tool,
          ...result,
        };
      },
    };
  }

  async execute(task) {
    const handle = this.start(task);
    const result = await handle.wait();

    if (result.exitCode !== 0) {
      throw new PhaseExecutionError(
        `story=${task.storyId} phase=${result.phase} 执行失败: exit=${result.exitCode}`,
        { code: "PHASE_EXEC_FAILED", retryable: true },
      );
    }

    return result;
  }

  _buildPrompt(task) {
    const lines = [
      "你是 Aha-Loop MQ 执行代理。",
      `当前 Story: ${task.storyId}`,
      `所属 PRD: ${task.prdId || "unknown"}`,
      `执行阶段: ${task.phase}`,
      `执行阶段(规范化): ${task.phase === "review" ? "review (quality-review)" : task.phase}`,
      `工作目录: ${task.worktreePath || task.workspacePath || process.cwd()}`,
      "要求：",
      "1) 严格完成当前阶段目标，不跨阶段修改。",
      "2) 变更后给出简短结果摘要。",
      "3) 若无法继续，返回明确错误原因。",
      "4) 允许工作目录中存在预置或并发变更（含 `.aha-loop/prd.json`、`*.bak` 等）；不要因 `git status` 非空或“非本次会话变更”而中止。",
      "5) 这是无人值守执行：不要请求人工确认或版本选择；仅在当前阶段内直接完成任务。",
      "6) 输出结束前必须追加一行结构化回执，格式如下（单行 JSON）：",
      `   ${PHASE_RESULT_PREFIX} {"status":"success","code":"OK","retryable":false,"message":"phase completed","artifacts":{},"nextAction":"advance"}`,
      "7) 若阶段失败，status 必须为 failed，并填写 code/message/retryable。",
      "8) 除该结构化回执外，可输出普通摘要文本。",
    ];
    return lines.join("\n");
  }

  _buildToolCommand(tool, prompt) {
    if (tool === "codex") {
      const args = ["exec"];
      if (this.config?.toolDangerousBypass === true) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      }
      if (this.config?.toolSkipGitRepoCheck !== false) {
        args.push("--skip-git-repo-check");
      }
      args.push(prompt);
      return {
        cmd: "codex",
        args,
      };
    }
    if (tool === "claude") {
      const args = [];
      if (this.config?.toolDangerousBypass === true) {
        args.push("--dangerously-skip-permissions");
      }
      args.push(prompt);
      return { cmd: "claude", args };
    }
    throw new PhaseExecutionError(`不支持的 tool: ${tool}`, { code: "UNSUPPORTED_TOOL", retryable: false });
  }
}

function normalizePhase(phase) {
  const normalized = normalizeStoryPhase(phase);
  return normalized || null;
}

function runCommandControlled(cmd, args, cwd) {
  const stdout = [];
  const stderr = [];
  const startedAtMs = Date.now();
  const startedAt = nowEast8Iso();
  let lastOutputAtMs = startedAtMs;
  let stdoutBytes = 0;
  let stderrBytes = 0;

  let proc = null;
  let settled = false;
  let cancelled = false;
  let cancelReason = null;
  let forceKillTimer = null;

  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const clearKillTimer = () => {
    if (!forceKillTimer) return;
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  };

  const settleResolve = (payload) => {
    if (settled) return;
    settled = true;
    clearKillTimer();
    resolveDone(payload);
  };

  const settleReject = (error) => {
    if (settled) return;
    settled = true;
    clearKillTimer();
    rejectDone(error);
  };

  const getOutput = () => ({
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  });

  const getStats = () => ({
    startedAtMs,
    lastOutputAtMs,
    lastOutputAt: toEast8Iso(lastOutputAtMs),
    idleMs: Math.max(0, Date.now() - lastOutputAtMs),
    stdoutBytes,
    stderrBytes,
  });

  try {
    proc = spawnPortable(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  } catch (err) {
    settleReject(new PhaseExecutionError(err.message, { code: "SPAWN_ERROR", retryable: true }));
  }

  if (proc?.stdout) {
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout.push(text);
      stdoutBytes += Buffer.byteLength(text);
      lastOutputAtMs = Date.now();
    });
  }
  if (proc?.stderr) {
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr.push(text);
      stderrBytes += Buffer.byteLength(text);
      lastOutputAtMs = Date.now();
    });
  }

  proc?.on("error", (err) => {
    settleReject(new PhaseExecutionError(err.message, { code: "SPAWN_ERROR", retryable: true }));
  });

  proc?.on("close", (code, signal) => {
    const output = getOutput();
    settleResolve({
      exitCode: typeof code === "number" ? code : -1,
      signal: signal || null,
      pid: proc?.pid || null,
      cancelled,
      cancelReason,
      startedAt,
      finishedAt: nowEast8Iso(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      ...getStats(),
      ...output,
      phaseResult: parsePhaseResultFromOutput(output),
    });
  });

  const cancel = (reason = "cancelled") => {
    if (!proc || settled) return false;
    cancelled = true;
    cancelReason = reason;

    try {
      const terminated = proc.kill("SIGTERM");
      if (!terminated) proc.kill();
    } catch {
      try { proc.kill(); } catch {}
    }

    forceKillTimer = setTimeout(() => {
      if (settled || !proc) return;
      try {
        const killed = proc.kill("SIGKILL");
        if (!killed) proc.kill();
      } catch {
        try { proc.kill(); } catch {}
      }
    }, 4_000);
    if (typeof forceKillTimer.unref === "function") forceKillTimer.unref();
    return true;
  };

  return {
    pid: proc?.pid || null,
    cancel,
    getOutput,
    getStats,
    done,
  };
}

function parsePhaseResultFromOutput(output) {
  const stdout = typeof output?.stdout === "string" ? output.stdout : "";
  const stderr = typeof output?.stderr === "string" ? output.stderr : "";
  const text = `${stdout}\n${stderr}`;
  if (!text.trim()) return null;

  const prefixReg = new RegExp(`${PHASE_RESULT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\{[^\\n]+\\})`, "g");
  const prefixMatches = [...text.matchAll(prefixReg)];
  if (prefixMatches.length > 0) {
    const candidate = prefixMatches[prefixMatches.length - 1][1];
    const parsed = parsePhaseResultJson(candidate);
    if (parsed) return parsed;
  }

  const blockReg = /<aha-loop-phase-result>\s*([\s\S]*?)\s*<\/aha-loop-phase-result>/gi;
  const blockMatches = [...text.matchAll(blockReg)];
  if (blockMatches.length > 0) {
    const candidate = blockMatches[blockMatches.length - 1][1];
    const parsed = parsePhaseResultJson(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function parsePhaseResultJson(jsonText) {
  if (!jsonText || typeof jsonText !== "string") return null;
  try {
    const data = JSON.parse(jsonText.trim());
    if (!data || typeof data !== "object") return null;
    const status = String(data.status || "").trim().toLowerCase();
    if (status !== "success" && status !== "failed") return null;
    const normalized = {
      status,
      code: data.code ? String(data.code) : (status === "success" ? "OK" : "PHASE_RESULT_FAILED"),
      retryable: typeof data.retryable === "boolean" ? data.retryable : (status !== "success"),
      message: data.message ? String(data.message) : "",
      nextAction: data.nextAction ? String(data.nextAction) : null,
      artifacts: data.artifacts && typeof data.artifacts === "object" ? data.artifacts : {},
    };
    return normalized;
  } catch {
    return null;
  }
}

module.exports = {
  PhaseEngine,
  PhaseExecutionError,
  normalizePhase,
  parsePhaseResultFromOutput,
  PHASE_RESULT_PREFIX,
};
