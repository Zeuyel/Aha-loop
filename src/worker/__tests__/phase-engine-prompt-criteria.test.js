"use strict";

const assert = require("node:assert/strict");
const { PhaseEngine } = require("../phase-engine");

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runCase("buildPrompt includes acceptance criteria when provided", () => {
  const engine = new PhaseEngine({}, console);
  const prompt = engine._buildPrompt({
    storyId: "US-AC-001",
    storyTitle: "Add checkout validation",
    prdId: "PRD-AC",
    phase: "review",
    worktreePath: "/tmp/wt",
    acceptanceCriteria: [
      "用户输入为空时，必须阻止提交并展示提示",
      "错误提示文案符合 PRD 约定",
    ],
  });

  assert.match(prompt, /验收标准（必须逐条对齐/);
  assert.match(prompt, /\[AC1\] 用户输入为空时，必须阻止提交并展示提示/);
  assert.match(prompt, /\[AC2\] 错误提示文案符合 PRD 约定/);
});

runCase("buildPrompt has explicit fallback when acceptance criteria missing", () => {
  const engine = new PhaseEngine({}, console);
  const prompt = engine._buildPrompt({
    storyId: "US-AC-002",
    storyTitle: "Fallback path",
    prdId: "PRD-AC",
    phase: "implement",
    worktreePath: "/tmp/wt",
    acceptanceCriteria: [],
  });

  assert.match(prompt, /验收标准: 未提供/);
});

runCase("buildPrompt requires acceptanceCriteriaCheck contract for review", () => {
  const engine = new PhaseEngine({}, console);
  const prompt = engine._buildPrompt({
    storyId: "US-AC-003",
    storyTitle: "Review gate",
    prdId: "PRD-AC",
    phase: "review",
    worktreePath: "/tmp/wt",
    acceptanceCriteria: ["AC-1", "AC-2"],
  });

  assert.match(prompt, /acceptanceCriteriaChecks/);
  assert.match(prompt, /review 阶段且存在验收标准/);
});
