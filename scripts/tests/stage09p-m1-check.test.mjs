import assert from "node:assert/strict";
import test from "node:test";

import {
  commandSucceeded,
  fixedFailureMessage,
  stage09pM1Steps,
} from "../run-stage09p-m1-check.mjs";

test("runner composition is the exact serial M1 targeted gate sequence", () => {
  assert.deepStrictEqual(
    stage09pM1Steps.map(({ args, command, id }) => ({
      args,
      command: command === process.execPath ? "<current-node>" : command,
      id,
    })),
    [
      { args: ["stage09p:m0:check"], command: "pnpm", id: "m0-check" },
      {
        args: ["--filter", "@meal-agent/domain", "typecheck"],
        command: "pnpm",
        id: "domain-typecheck",
      },
      {
        args: ["--filter", "@meal-agent/domain", "build"],
        command: "pnpm",
        id: "domain-build",
      },
      {
        args: [
          "--filter",
          "@meal-agent/domain",
          "exec",
          "node",
          "--import",
          "tsx",
          "--test",
          "tests/household-safety.test.ts",
        ],
        command: "pnpm",
        id: "household-safety-tests",
      },
      {
        args: [
          "--test",
          "scripts/tests/stage09p-m1-check.test.mjs",
          "scripts/tests/stage09p-m1-scope.test.mjs",
          "scripts/tests/stage09p-m1-source-pack.test.mjs",
        ],
        command: "<current-node>",
        id: "m1-checker-tests",
      },
      {
        args: [
          "scripts/check-stage09p-m1-source-pack.mjs",
          "--as-of=2026-08-29T00:00:00.000Z",
        ],
        command: "<current-node>",
        id: "source-pack-check",
      },
      {
        args: [
          "scripts/check-stage09p-m1-scope.mjs",
          "--expected-base=1a66015e63ac84c6257be46a36c5c5967ee53f20",
        ],
        command: "<current-node>",
        id: "scope-check",
      },
      { args: ["diff", "--check"], command: "git", id: "diff-check" },
    ],
  );
  assert(Object.isFrozen(stage09pM1Steps));
  assert(stage09pM1Steps.every(Object.isFrozen));
});

test("runner accepts only an ordinary zero exit without error or signal", () => {
  assert.equal(
    commandSucceeded({ error: undefined, signal: null, status: 0 }),
    true,
  );
  assert.equal(
    commandSucceeded({ error: new Error("inert"), signal: null, status: 0 }),
    false,
  );
  assert.equal(
    commandSucceeded({ error: undefined, signal: "SIGTERM", status: null }),
    false,
  );
  assert.equal(
    commandSucceeded({ error: undefined, signal: null, status: 1 }),
    false,
  );
  assert.equal(commandSucceeded(null), false);
});

test("runner failure messages expose only a fixed internal step identifier", () => {
  for (const step of stage09pM1Steps) {
    assert.equal(
      fixedFailureMessage(step),
      `stage09p:m1 check FAIL ${step.id}\n`,
    );
    assert(!fixedFailureMessage(step).includes("inert raw sentinel"));
  }
});
