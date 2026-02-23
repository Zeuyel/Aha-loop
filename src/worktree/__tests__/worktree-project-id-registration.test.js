"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { WorktreeManager } = require("../worktree");

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
    this.items = [];
  }

  setWorktree(worktree) {
    this.items.push({ ...worktree });
  }
}

function createManager(store) {
  return new WorktreeManager(
    { workspace: process.cwd(), worktreeDir: path.resolve(process.cwd(), ".worktrees-test") },
    store,
    { info() {}, warn() {}, error() {} },
  );
}

runCase("register new/reused worktree carries projectId", () => {
  const store = new FakeStore();
  const manager = createManager(store);

  const wtNew = manager._registerNewWorktree("ST-1", "proj-1", "story/ST-1", "/tmp/wt-1");
  const wtReuse = manager._registerReusedWorktree("ST-2", "proj-2", "story/ST-2", "/tmp/wt-2");

  assert.equal(wtNew.projectId, "proj-1");
  assert.equal(wtReuse.projectId, "proj-2");
  assert.equal(store.items[0].projectId, "proj-1");
  assert.equal(store.items[1].projectId, "proj-2");
});
