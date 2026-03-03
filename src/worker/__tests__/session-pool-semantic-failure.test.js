"use strict";

const assert = require("node:assert/strict");
const { detectSemanticFailureFromOutput } = require("../session-pool");

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runCase("detectSemanticFailureFromOutput detects chinese error prefix", () => {
  const result = detectSemanticFailureFromOutput({
    stdout: "错误：当前工作目录中不存在 `PRD-008-S01` 的可规划源数据，无法继续执行。",
    stderr: "",
  });
  assert.ok(result);
  assert.equal(result.code, "PHASE_SEMANTIC_FAILURE");
  assert.equal(result.source, "session_pool");
});

runCase("detectSemanticFailureFromOutput detects block report with error reason", () => {
  const result = detectSemanticFailureFromOutput({
    stdout: [
      "已按 `plan` 阶段完成阻塞处理（未跨阶段修改实现代码）。",
      "",
      "错误原因：当前工作树的计划上下文与目标不一致。",
    ].join("\n"),
    stderr: "",
  });
  assert.ok(result);
  assert.match(result.message, /semantic failure signal/i);
});

runCase("detectSemanticFailureFromOutput marks interactive confirmation block as retryable", () => {
  const result = detectSemanticFailureFromOutput({
    stdout: [
      "当前无法继续执行 `plan` 阶段写入，原因如下：",
      "1. 检测到工作区存在我未创建的变更。",
      "请确认你希望我如何继续：",
      "1. 在现有变更基础上继续。",
    ].join("\n"),
    stderr: "",
  });
  assert.ok(result);
  assert.equal(result.code, "PHASE_SEMANTIC_FAILURE");
  assert.equal(result.retryable, true);
});

runCase("detectSemanticFailureFromOutput ignores normal success summary", () => {
  const result = detectSemanticFailureFromOutput({
    stdout: [
      "已完成 plan 阶段产出。",
      "变更摘要：",
      "- 更新了 planning 文档并附测试说明。",
    ].join("\n"),
    stderr: "",
  });
  assert.equal(result, null);
});

runCase("detectSemanticFailureFromOutput detects english cannot continue", () => {
  const result = detectSemanticFailureFromOutput({
    stdout: "Cannot continue: planning source data is missing for this story.",
    stderr: "",
  });
  assert.ok(result);
  assert.equal(result.code, "PHASE_SEMANTIC_FAILURE");
});
