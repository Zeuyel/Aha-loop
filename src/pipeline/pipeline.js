"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnPortable } = require("../core/spawn-portable");
const { nowEast8Iso } = require("../core/time");

/**
 * Pipeline — Vision → Architect → Roadmap → PRD 自动化流水线
 */
class Pipeline {
  constructor(config, store, logger = console) {
    this.config = config;
    this.store = store;
    this.logger = logger;
  }

  async run(visionFile) {
    const absVisionFile = path.resolve(visionFile);
    this.logger.info(`[pipeline] starting from vision: ${absVisionFile}`);

    this.store.setPipeline({
      visionFile: absVisionFile,
      status: "loaded",
      createdAt: nowEast8Iso(),
    });

    try {
      const visionContent = await fsp.readFile(absVisionFile, "utf8");

      this.store.setPipeline({ ...this.store.getPipeline(), status: "architecting" });
      this.logger.info("[pipeline] phase: architecting...");
      const architectureContent = await this._runArchitect(visionContent, absVisionFile);
      await this._writeTextFile(this.config.architectureFile, architectureContent);

      this.store.setPipeline({ ...this.store.getPipeline(), status: "planning_roadmap" });
      this.logger.info("[pipeline] phase: planning roadmap...");
      const roadmap = await this._runRoadmap({
        visionContent,
        architectureContent,
        visionFile: absVisionFile,
        architectureFile: this.config.architectureFile,
      });
      await this._writeJsonFile(this.config.roadmapOutputFile, roadmap);

      this.store.setPipeline({ ...this.store.getPipeline(), status: "generating_prds" });
      this.logger.info("[pipeline] phase: generating PRDs...");

      const { loadPrds } = require("./prd-loader");
      await loadPrds(this.config.roadmapOutputFile, this.store, this.logger, {
        workspacePath: this.config.workspace,
      });

      this.store.setPipeline({ ...this.store.getPipeline(), status: "executing" });
      this.logger.info("[pipeline] planning complete, entering execution phase");

      if (this.config.planOnly) {
        this.logger.info("[pipeline] --plan-only: stopping before execution");
      }
    } catch (err) {
      this.store.setPipeline({ ...this.store.getPipeline(), status: "failed", error: err.message });
      throw err;
    }
  }

  async _runArchitect(visionContent, visionFile) {
    const prompt = [
      "你是 Aha-Loop 架构规划助手。",
      `输入文件: ${visionFile}`,
      "请基于下方 Vision 输出架构设计说明（Markdown）：",
      "- 系统目标与边界",
      "- 模块划分与职责",
      "- 核心数据流/状态流",
      "- 风险与演进建议",
      "",
      "Vision 内容：",
      visionContent,
    ].join("\n");

    const output = await this._runTool("architect", prompt);
    const text = output.trim();
    if (!text) throw new Error("architect 阶段未返回有效内容");
    return text;
  }

  async _runRoadmap({ visionContent, architectureContent, visionFile, architectureFile }) {
    const prompt = [
      "你是 Aha-Loop Roadmap 规划助手。",
      `Vision 文件: ${visionFile}`,
      `Architecture 文件: ${architectureFile}`,
      "请仅输出 JSON，不要额外解释，不要 markdown 代码块。",
      "JSON 结构必须包含 prds 数组，每个 PRD 至少包含 id/title/stories，stories 中包含 id/title。",
      "",
      "Vision 内容：",
      visionContent,
      "",
      "Architecture 内容：",
      architectureContent,
    ].join("\n");

    const output = await this._runTool("roadmap", prompt);
    const parsed = this._extractJson(output);
    if (!Array.isArray(parsed.prds) && !Array.isArray(parsed.milestones)) {
      throw new Error("roadmap 阶段输出缺少 prds/milestones 数组");
    }
    return parsed;
  }

  async _runTool(stage, prompt) {
    if (this.config.dryRun) {
      this.logger.info(`[pipeline] DRY-RUN stage=${stage}`);
      if (stage === "roadmap") {
        return JSON.stringify({ prds: [] });
      }
      return `# ${stage}\n\nDRY-RUN`;
    }

    const tool = (this.config.defaultTool || "codex").toLowerCase();
    const command = this._buildToolCommand(tool, prompt);
    const result = await this._exec(command.cmd, command.args, this.config.workspace);

    if (result.exitCode !== 0) {
      throw new Error(`[pipeline] ${stage} 执行失败: exit=${result.exitCode} stderr=${result.stderr}`);
    }

    return (result.stdout || "").trim();
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
      if (this.config?.toolDangerousBypass === true) args.push("--dangerously-skip-permissions");
      args.push(prompt);
      return { cmd: "claude", args };
    }
    throw new Error(`不支持的 tool: ${tool}`);
  }

  _extractJson(text) {
    const trimmed = (text || "").trim();
    const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```\s*([\s\S]*?)```/i);
    const candidate = (fenced && fenced[1]) ? fenced[1].trim() : trimmed;
    return JSON.parse(candidate);
  }

  async _writeTextFile(filePath, content) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, `${content.trim()}\n`, "utf8");
  }

  async _writeJsonFile(filePath, data) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  _exec(cmd, args, cwd) {
    return new Promise((resolve, reject) => {
      const proc = spawnPortable(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
      const stdout = [];
      const stderr = [];
      proc.stdout.on("data", (c) => stdout.push(c.toString()));
      proc.stderr.on("data", (c) => stderr.push(c.toString()));
      proc.on("error", (err) => reject(err));
      proc.on("exit", (code) => resolve({ exitCode: code ?? -1, stdout: stdout.join(""), stderr: stderr.join("") }));
    });
  }
}

module.exports = { Pipeline };
