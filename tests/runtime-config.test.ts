import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAbsolutePaths,
  parseEnabled,
  parseOptionalPort,
  parsePort,
  parseStringArray,
  parseToolNames,
  validateJsonObject,
} from "../src/runtime-config.js";

test("trusted resource paths require unique absolute paths", () => {
  assert.deepEqual(parseAbsolutePaths('["/app/skills","/app/skills"]', "PATHS"), ["/app/skills"]);
  assert.throws(() => parseAbsolutePaths('[".pi/skills"]', "PATHS"), /must be absolute/);
});

test("tool selection accepts built-in and trusted extension tool names", () => {
  assert.deepEqual(parseToolNames('["read","grep","save_memory"]'), ["read", "grep", "save_memory"]);
  assert.equal(parseToolNames(undefined), undefined);
  assert.throws(() => parseToolNames('["bad tool"]'), /invalid tool names/);
});

test("JSON arrays and booleans fail closed", () => {
  assert.deepEqual(parseStringArray(undefined, "VALUE"), []);
  assert.throws(() => parseStringArray("read,bash", "VALUE"), /JSON array/);
  assert.equal(parseEnabled("true", "FLAG"), true);
  assert.equal(parseEnabled(undefined, "FLAG"), false);
  assert.throws(() => parseEnabled("yes", "FLAG"), /must be one of/);
  validateJsonObject('{"enabled":true}', "OBJECT");
  assert.throws(() => validateJsonObject("[]", "OBJECT"), /JSON object/);
  assert.equal(parsePort(undefined, "PORT", 8080), 8080);
  assert.equal(parseOptionalPort(undefined, "PORT"), undefined);
  assert.throws(() => parseOptionalPort("0", "PORT"), /1 to 65535/);
});
