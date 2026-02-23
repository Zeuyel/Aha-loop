"use strict";

const assert = require("node:assert/strict");
const { parsePhaseResultFromOutput, PHASE_RESULT_PREFIX } = require("../phase-engine");

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runCase("parsePhaseResultFromOutput parses prefixed single-line JSON contract", () => {
  const result = parsePhaseResultFromOutput({
    stdout: `phase done\n${PHASE_RESULT_PREFIX} {"status":"success","code":"OK","retryable":false,"message":"done","artifacts":{"summary":"ok"}}`,
    stderr: "",
  });
  assert.ok(result);
  assert.equal(result.status, "success");
  assert.equal(result.code, "OK");
  assert.equal(result.retryable, false);
  assert.equal(result.message, "done");
  assert.equal(result.artifacts.summary, "ok");
});

runCase("parsePhaseResultFromOutput parses xml wrapper contract", () => {
  const result = parsePhaseResultFromOutput({
    stdout: [
      "processing...",
      "<aha-loop-phase-result>",
      '{"status":"failed","code":"PHASE_INPUT_MISSING","retryable":false,"message":"missing plan input"}',
      "</aha-loop-phase-result>",
    ].join("\n"),
    stderr: "",
  });
  assert.ok(result);
  assert.equal(result.status, "failed");
  assert.equal(result.code, "PHASE_INPUT_MISSING");
  assert.equal(result.retryable, false);
});

runCase("parsePhaseResultFromOutput ignores malformed payload", () => {
  const result = parsePhaseResultFromOutput({
    stdout: `${PHASE_RESULT_PREFIX} not-json`,
    stderr: "",
  });
  assert.equal(result, null);
});
