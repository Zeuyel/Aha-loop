"use strict";

const assert = require("node:assert/strict");
const { normalizeStoryPhase, nextPhase } = require("../schemas");

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runCase("normalizeStoryPhase maps quality aliases to review", () => {
  assert.equal(normalizeStoryPhase("quality-review"), "review");
  assert.equal(normalizeStoryPhase("quality_review"), "review");
  assert.equal(normalizeStoryPhase("qa"), "review");
  assert.equal(normalizeStoryPhase("quality"), "review");
});

runCase("nextPhase works with normalized aliases", () => {
  const phases = ["research", "explore", "plan", "implement", "quality-review"];
  assert.equal(nextPhase("implement", phases), "review");
  assert.equal(nextPhase("review", phases), null);
});
