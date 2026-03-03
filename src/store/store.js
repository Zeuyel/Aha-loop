"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { storyMachine, prdMachine } = require("./schemas");
const { nowEast8Iso } = require("../core/time");

const nowIso = () => nowEast8Iso();

/**
 * 统一存储: Pipeline / PRD / Story / Session / Worktree
 * 所有状态变更通过状态机校验
 */
class Store {
  constructor(stateFile, eventBus, logger = console) {
    this.stateFile = stateFile;
    this.eventBus = eventBus;
    this.logger = logger;

    this._prds = new Map();
    this._stories = new Map();
    this._sessions = new Map();
    this._runs = new Map();
    this._worktrees = new Map();
    this._projects = new Map();
    this._pipeline = null;

    this._flushTimer = null;
    this._dirty = false;
    this._revision = 0;
    this._savingPromise = null;
    this._lockFile = `${this.stateFile}.lock`;
  }

  async init() {
    await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
    if (!fs.existsSync(this.stateFile)) {
      await this._save();
      return;
    }
    const raw = await fsp.readFile(this.stateFile, "utf8");
    const data = JSON.parse(raw);
    this._revision = Number.isFinite(Number(data.revision)) ? Number(data.revision) : 0;
    for (const p of data.prds || []) this._prds.set(p.id, p);
    for (const s of data.stories || []) this._stories.set(s.id, s);
    for (const s of data.sessions || []) this._sessions.set(s.id, s);
    for (const r of data.runs || []) this._runs.set(r.id, r);
    for (const w of data.worktrees || []) this._worktrees.set(w.id, w);
    for (const p of data.projects || []) this._projects.set(p.id, p);
    this._pipeline = data.pipeline || null;
  }

  // ─── Pipeline ──────────────────────────
  getPipeline() { return this._pipeline; }
  setPipeline(p, options = {}) {
    this._assertRevision(this._pipeline, options.expectedRevision, "pipeline");
    const next = {
      ...p,
      updatedAt: nowIso(),
      revision: this._nextRevision(),
    };
    this._pipeline = next;
    this._scheduleSave();
    return next;
  }

  resetExecutionState({ keepPipeline = true, keepProjects = true } = {}) {
    this._prds.clear();
    this._stories.clear();
    this._sessions.clear();
    this._runs.clear();
    this._worktrees.clear();
    if (!keepProjects) this._projects.clear();
    if (!keepPipeline) this._pipeline = null;
    this._nextRevision();
    this._scheduleSave();
    this.eventBus.fire("store:reset", {
      at: nowIso(),
      keepPipeline,
      keepProjects,
    });
  }

  // ─── PRD ──────────────────────────────
  listPrds(filter) {
    let result = Array.from(this._prds.values());
    if (filter?.status) result = result.filter((p) => p.status === filter.status);
    if (filter && Object.prototype.hasOwnProperty.call(filter, "projectId")) {
      result = result.filter((p) => (p.projectId || null) === (filter.projectId || null));
    }
    return result;
  }
  getPrd(id) { return this._prds.get(id) || null; }
  setPrd(prd, options = {}) {
    const current = this._prds.get(prd.id) || null;
    this._assertRevision(current, options.expectedRevision, `prd:${prd.id}`);
    const next = {
      ...prd,
      updatedAt: nowIso(),
      revision: this._nextRevision(),
    };
    this._prds.set(next.id, next);
    this._scheduleSave();
    this.eventBus.fire("prd:updated", next);
    return next;
  }
  transitionPrd(id, targetStatus, patch = {}) {
    const prd = this._prds.get(id);
    if (!prd) throw new Error(`PRD ${id} not found`);
    const updated = prdMachine.transition(prd, targetStatus, patch);
    return this.setPrd(updated);
  }

  // ─── Story ────────────────────────────
  listStories(filter) {
    let result = Array.from(this._stories.values());
    if (filter?.status) result = result.filter((s) => s.status === filter.status);
    if (filter?.prdId) result = result.filter((s) => s.prdId === filter.prdId);
    if (filter && Object.prototype.hasOwnProperty.call(filter, "projectId")) {
      result = result.filter((s) => (s.projectId || null) === (filter.projectId || null));
    }
    return result;
  }
  getStory(id) { return this._stories.get(id) || null; }
  setStory(story, options = {}) {
    const current = this._stories.get(story.id) || null;
    this._assertRevision(current, options.expectedRevision, `story:${story.id}`);
    const next = {
      ...story,
      updatedAt: nowIso(),
      revision: this._nextRevision(),
    };
    this._stories.set(next.id, next);
    this._scheduleSave();
    this.eventBus.fire("story:updated", next);
    return next;
  }
  transitionStory(id, targetStatus, patch = {}) {
    const story = this._stories.get(id);
    if (!story) throw new Error(`Story ${id} not found`);
    const updated = storyMachine.transition(story, targetStatus, patch);
    return this.setStory(updated);
  }

  // ─── Session ──────────────────────────
  listSessions(filter) {
    let result = Array.from(this._sessions.values());
    if (filter?.status) result = result.filter((s) => s.status === filter.status);
    if (filter?.storyId) result = result.filter((s) => s.storyId === filter.storyId);
    if (filter && Object.prototype.hasOwnProperty.call(filter, "projectId")) {
      result = result.filter((s) => (s.projectId || null) === (filter.projectId || null));
    }
    return result;
  }
  getSession(id) { return this._sessions.get(id) || null; }
  setSession(session, options = {}) {
    const current = this._sessions.get(session.id) || null;
    this._assertRevision(current, options.expectedRevision, `session:${session.id}`);
    const next = {
      ...session,
      updatedAt: nowIso(),
      revision: this._nextRevision(),
    };
    this._sessions.set(next.id, next);
    this._scheduleSave();
    this.eventBus.fire("session:updated", next);
    return next;
  }

  // ─── Run (codex 调用级执行记录) ───────
  listRuns(filter) {
    let result = Array.from(this._runs.values());
    if (filter?.status) result = result.filter((r) => r.status === filter.status);
    if (filter?.storyId) result = result.filter((r) => r.storyId === filter.storyId);
    if (filter?.prdId) result = result.filter((r) => r.prdId === filter.prdId);
    if (filter?.phase) result = result.filter((r) => r.phase === filter.phase);
    if (filter && Object.prototype.hasOwnProperty.call(filter, "projectId")) {
      result = result.filter((r) => (r.projectId || null) === (filter.projectId || null));
    }
    return result;
  }

  getRun(id) { return this._runs.get(id) || null; }

  setRun(run, options = {}) {
    const current = this._runs.get(run.id) || null;
    this._assertRevision(current, options.expectedRevision, `run:${run.id}`);
    const next = {
      ...run,
      updatedAt: nowIso(),
      revision: this._nextRevision(),
    };
    this._runs.set(next.id, next);
    this._scheduleSave();
    this.eventBus.fire("run:updated", next);
    return next;
  }

  // ─── Worktree ─────────────────────────
  listWorktrees(filter) {
    let result = Array.from(this._worktrees.values());
    if (filter?.status) result = result.filter((w) => w.status === filter.status);
    if (filter?.storyId) result = result.filter((w) => w.storyId === filter.storyId);
    if (filter && Object.prototype.hasOwnProperty.call(filter, "projectId")) {
      result = result.filter((w) => (w.projectId || null) === (filter.projectId || null));
    }
    return result;
  }
  getWorktree(id) { return this._worktrees.get(id) || null; }
  setWorktree(wt, options = {}) {
    const current = this._worktrees.get(wt.id) || null;
    this._assertRevision(current, options.expectedRevision, `worktree:${wt.id}`);
    const next = {
      ...wt,
      updatedAt: nowIso(),
      revision: this._nextRevision(),
    };
    this._worktrees.set(next.id, next);
    this._scheduleSave();
    return next;
  }

  // ─── Project ──────────────────────────
  listProjects() {
    return Array.from(this._projects.values());
  }

  getProject(id) {
    return this._projects.get(id) || null;
  }

  setProject(project, options = {}) {
    const current = this._projects.get(project.id) || null;
    this._assertRevision(current, options.expectedRevision, `project:${project.id}`);
    const next = {
      ...project,
      updatedAt: nowIso(),
      revision: this._nextRevision(),
    };
    this._projects.set(next.id, next);
    this._scheduleSave();
    this.eventBus.fire("project:updated", next);
    return next;
  }

  deleteProject(id) {
    const existing = this._projects.get(id);
    if (!existing) return false;
    this._projects.delete(id);
    this._nextRevision();
    this._scheduleSave();
    this.eventBus.fire("project:deleted", { id, at: nowIso() });
    return true;
  }

  // ─── 持久化 ───────────────────────────
  _scheduleSave() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (this._dirty) this._save().catch((e) => this.logger.error(`[store] flush error: ${e.message}`));
    }, 100);
  }

  async flushNow() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (this._dirty) await this._save();
  }

  async _save() {
    if (this._savingPromise) return this._savingPromise;
    this._savingPromise = this._saveInternal().finally(() => {
      this._savingPromise = null;
    });
    return this._savingPromise;
  }

  async _saveInternal() {
    const release = await this._acquireLock();
    const payload = {
      version: 1,
      revision: this._revision,
      updatedAt: nowIso(),
      pipeline: this._pipeline,
      prds: Array.from(this._prds.values()),
      stories: Array.from(this._stories.values()),
      sessions: Array.from(this._sessions.values()),
      runs: Array.from(this._runs.values()),
      worktrees: Array.from(this._worktrees.values()),
      projects: Array.from(this._projects.values()),
    };
    const tmp = `${this.stateFile}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
      await fsp.rename(tmp, this.stateFile);
      this._dirty = false;
    } finally {
      await release();
    }
  }

  _nextRevision() {
    this._revision += 1;
    return this._revision;
  }

  _assertRevision(current, expectedRevision, label) {
    if (expectedRevision == null) return;
    const currentRevision = Number.isFinite(Number(current?.revision)) ? Number(current.revision) : null;
    const expected = Number(expectedRevision);
    if (!Number.isFinite(expected)) return;
    if (currentRevision === expected) return;

    const err = new Error(`revision conflict on ${label}: expected=${expected}, current=${currentRevision}`);
    err.code = "STORE_REVISION_CONFLICT";
    err.expectedRevision = expected;
    err.currentRevision = currentRevision;
    throw err;
  }

  async _acquireLock() {
    const lockPath = this._lockFile;
    const maxWaitMs = 2_000;
    const staleAfterMs = 15_000;
    const started = Date.now();

    while (true) {
      try {
        const handle = await fsp.open(lockPath, "wx");
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, acquiredAt: nowIso(), stateFile: this.stateFile }) + "\n",
          "utf8",
        );
        await handle.close();
        return async () => {
          try {
            await fsp.unlink(lockPath);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const stat = await fsp.stat(lockPath);
          if ((Date.now() - stat.mtimeMs) > staleAfterMs) {
            await fsp.unlink(lockPath).catch(() => {});
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
        }

        if ((Date.now() - started) > maxWaitMs) {
          const err = new Error(`state lock timeout: ${lockPath}`);
          err.code = "STORE_LOCK_TIMEOUT";
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}

module.exports = { Store };
