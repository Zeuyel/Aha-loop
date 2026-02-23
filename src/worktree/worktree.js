"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const crypto = require("node:crypto");
const { nowEast8Iso } = require("../core/time");

const exec = promisify(execFile);

/**
 * WorktreeManager — Git worktree 生命周期管理
 * ensure (创建/复用) → merge (合并回主分支) → cleanup (删除)
 */
class WorktreeManager {
  constructor(config, store, logger = console) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.worktreeDir = config.worktreeDir;
    this.workspace = config.workspace;
  }

  async ensure(story) {
    const worktreeFilter = { storyId: story.id, status: "active" };
    if (story.projectId) worktreeFilter.projectId = story.projectId;
    const existing = this.store.listWorktrees(worktreeFilter);
    if (existing.length > 0) return existing[0];

    const branch = `story/${story.id}`;
    const branchRef = `refs/heads/${branch}`;
    const wtPath = path.join(this.worktreeDir, story.id);

    const reused = await this._discoverExisting(branchRef, wtPath);
    if (reused) return this._registerReusedWorktree(story.id, story.projectId || null, branch, reused.path);

    const branchExists = await this._branchExists(branchRef);
    const args = branchExists
      ? ["worktree", "add", wtPath, branch]
      : ["worktree", "add", wtPath, "-b", branch];

    try {
      await exec("git", args, { cwd: this.workspace });
      this.logger.info("[worktree] created", {
        event: "worktree_create",
        storyId: story.id,
        branch,
        path: wtPath,
      });
      return this._registerNewWorktree(story.id, story.projectId || null, branch, wtPath);
    } catch (err) {
      const message = String(err?.stderr || err?.message || "");
      const recoverable = (
        message.includes("already exists")
        || message.includes("already checked out")
        || message.includes("is not an empty directory")
      );
      if (!recoverable) throw err;

      const fallback = await this._discoverExisting(branchRef, wtPath);
      if (!fallback) throw err;

      this.logger.warn("[worktree] reused existing worktree after create conflict", {
        event: "reconcile",
        storyId: story.id,
        branch,
        path: fallback.path,
        error: message,
      });
      return this._registerReusedWorktree(story.id, story.projectId || null, branch, fallback.path);
    }
  }

  async merge(worktreeId) {
    const wt = this.store.getWorktree(worktreeId);
    if (!wt) throw new Error(`worktree ${worktreeId} not found`);

    try {
      const { stdout: mainBranch } = await exec(
        "git", ["symbolic-ref", "--short", "HEAD"],
        { cwd: this.workspace },
      );

      await exec("git", ["merge", wt.branch, "--no-ff", "-m", `merge: ${wt.storyId}`], {
        cwd: this.workspace,
      });

      wt.status = "merged";
      wt.mergedAt = nowEast8Iso();
      this.store.setWorktree(wt);
      this.logger.info("[worktree] merged", {
        event: "merge",
        storyId: wt.storyId || null,
        branch: wt.branch,
        targetBranch: mainBranch.trim(),
      });
      return { ok: true };
    } catch (err) {
      const msg = err.stderr || err.message || "";
      if (msg.includes("CONFLICT")) {
        await exec("git", ["merge", "--abort"], { cwd: this.workspace }).catch(() => {});
        const conflicts = msg.match(/CONFLICT.*?:\s*(.+)/g) || [msg];
        this.logger.error("[worktree] merge conflict", {
          event: "fail",
          storyId: wt.storyId || null,
          branch: wt.branch,
          error: msg,
        });
        return { ok: false, conflicts };
      }
      throw err;
    }
  }

  async cleanup(worktreeId) {
    const wt = this.store.getWorktree(worktreeId);
    if (!wt) return;

    try {
      await exec("git", ["worktree", "remove", wt.path, "--force"], { cwd: this.workspace });
    } catch {
      this.logger.warn("[worktree] remove failed", {
        event: "reconcile",
        storyId: wt.storyId || null,
        branch: wt.branch,
        path: wt.path,
      });
    }

    try {
      await exec("git", ["branch", "-D", wt.branch], { cwd: this.workspace });
    } catch {
      this.logger.warn("[worktree] branch delete failed", {
        event: "reconcile",
        storyId: wt.storyId || null,
        branch: wt.branch,
      });
    }

    wt.status = "cleaned";
    wt.cleanedAt = nowEast8Iso();
    this.store.setWorktree(wt);
    this.logger.info("[worktree] cleaned", {
      event: "worktree_clean",
      storyId: wt.storyId || null,
      branch: wt.branch,
      path: wt.path,
    });
  }

  list() {
    return this.store.listWorktrees();
  }

  async _branchExists(branchRef) {
    try {
      await exec("git", ["rev-parse", "--verify", "--quiet", branchRef], { cwd: this.workspace });
      return true;
    } catch {
      return false;
    }
  }

  async _discoverExisting(branchRef, wtPath) {
    const targetPath = path.resolve(wtPath).toLowerCase();
    const worktrees = await this._listWorktrees();
    return worktrees.find((wt) => {
      const samePath = path.resolve(wt.path).toLowerCase() === targetPath;
      const sameBranch = wt.branch === branchRef;
      return samePath || sameBranch;
    }) || null;
  }

  async _listWorktrees() {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], { cwd: this.workspace });
    const lines = stdout.split(/\r?\n/);
    const items = [];
    let current = null;

    for (const line of lines) {
      if (!line.trim()) {
        if (current?.path) items.push(current);
        current = null;
        continue;
      }

      if (line.startsWith("worktree ")) {
        if (current?.path) items.push(current);
        current = { path: line.slice("worktree ".length), branch: null };
        continue;
      }

      if (!current) continue;
      if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).trim();
      }
    }

    if (current?.path) items.push(current);
    return items;
  }

  _registerNewWorktree(storyId, projectId, branch, wtPath) {
    const wt = {
      id: `wt-${crypto.randomUUID().slice(0, 8)}`,
      storyId,
      projectId: projectId || null,
      branch,
      path: wtPath,
      status: "active",
      createdAt: nowEast8Iso(),
      mergedAt: null,
      cleanedAt: null,
    };
    this.store.setWorktree(wt);
    return wt;
  }

  _registerReusedWorktree(storyId, projectId, branch, wtPath) {
    const wt = {
      id: `wt-${crypto.randomUUID().slice(0, 8)}`,
      storyId,
      projectId: projectId || null,
      branch,
      path: wtPath,
      status: "active",
      createdAt: nowEast8Iso(),
      recoveredAt: nowEast8Iso(),
      mergedAt: null,
      cleanedAt: null,
    };
    this.store.setWorktree(wt);
    return wt;
  }
}

module.exports = { WorktreeManager };
