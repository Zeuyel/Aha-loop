"use strict";

const assert = require("node:assert/strict");
const { validateAcceptanceCriteriaEvidence } = require("../session-pool");

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runCase("validateAcceptanceCriteriaEvidence ignores stories without acceptance criteria", () => {
  const failure = validateAcceptanceCriteriaEvidence(
    {
      phase: "implement",
      acceptanceCriteria: [],
    },
    null,
  );
  assert.equal(failure, null);
});

runCase("validateAcceptanceCriteriaEvidence blocks success without structured phase result when AC exists", () => {
  const failure = validateAcceptanceCriteriaEvidence(
    {
      phase: "implement",
      acceptanceCriteria: ["AC1", "AC2"],
    },
    null,
  );
  assert.ok(failure);
  assert.equal(failure.code, "PHASE_ACCEPTANCE_EVIDENCE_MISSING");
});

runCase("validateAcceptanceCriteriaEvidence blocks incomplete checks", () => {
  const failure = validateAcceptanceCriteriaEvidence(
    {
      phase: "review",
      acceptanceCriteria: ["AC1", "AC2", "AC3"],
    },
    {
      status: "success",
      artifacts: {
        acceptanceCriteriaChecks: [
          { id: "AC1", status: "pass" },
          { id: "AC2", status: "ok" },
        ],
      },
    },
  );
  assert.ok(failure);
  assert.equal(failure.code, "PHASE_ACCEPTANCE_EVIDENCE_INCOMPLETE");
  assert.deepEqual(failure.missingChecks, ["AC3"]);
});

runCase("validateAcceptanceCriteriaEvidence blocks failed checks", () => {
  const failure = validateAcceptanceCriteriaEvidence(
    {
      phase: "review",
      acceptanceCriteria: ["AC1", "AC2"],
    },
    {
      status: "success",
      artifacts: {
        acceptanceCriteriaChecks: [
          { id: "AC1", status: "pass" },
          { index: 1, status: "failed", evidence: "test failed" },
        ],
      },
    },
  );
  assert.ok(failure);
  assert.equal(failure.code, "PHASE_ACCEPTANCE_CHECKS_FAILED");
  assert.deepEqual(failure.failedChecks, ["AC2"]);
});

runCase("validateAcceptanceCriteriaEvidence accepts when all checks pass", () => {
  const failure = validateAcceptanceCriteriaEvidence(
    {
      phase: "review",
      acceptanceCriteria: ["AC1", "AC2"],
    },
    {
      status: "success",
      artifacts: {
        acceptanceCriteriaChecks: [
          { id: "AC1", status: "pass", evidence: "covered by test A" },
          { index: 1, status: "ok", evidence: "covered by test B" },
        ],
      },
    },
  );
  assert.equal(failure, null);
});
