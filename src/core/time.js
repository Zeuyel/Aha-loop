"use strict";

const EAST8_OFFSET_MS = 8 * 60 * 60 * 1000;

function toEast8Iso(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + EAST8_OFFSET_MS);
  return shifted.toISOString().replace("Z", "+08:00");
}

function nowEast8Iso() {
  return toEast8Iso(Date.now());
}

module.exports = {
  EAST8_OFFSET_MS,
  toEast8Iso,
  nowEast8Iso,
};

