import assert from "node:assert/strict";
import test from "node:test";

import {
  commandSucceeded,
  fixedFailureMessage,
  stage09pM0Steps,
} from "../run-stage09p-m0-check.mjs";

test("runner composition is the fixed direct R1, schema, R2, and scope sequence", () => {
  assert.deepStrictEqual(
    stage09pM0Steps.map(({ args, command, id }) => ({
      args,
      command: command === process.execPath ? "<current-node>" : command,
      id,
    })),
    [
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
        args: ["--filter", "@meal-agent/domain", "test"],
        command: "pnpm",
        id: "r1-tests",
      },
      {
        args: ["--filter", "@meal-agent/domain", "test:schema"],
        command: "pnpm",
        id: "schema-tests",
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
          "tests/catalog.test.ts",
          "tests/lifecycle.test.ts",
          "tests/resolution.test.ts",
          "tests/fixtures.test.ts",
        ],
        command: "pnpm",
        id: "r2-direct-tests",
      },
      {
        args: ["scripts/check-stage09p-m0-scope.mjs"],
        command: "<current-node>",
        id: "scope-and-fixtures",
      },
    ],
  );
  assert(Object.isFrozen(stage09pM0Steps));
  assert(stage09pM0Steps.every(Object.isFrozen));
});

test("runner accepts only an ordinary zero exit without error or signal", () => {
  assert.equal(commandSucceeded({ error: undefined, signal: null, status: 0 }), true);
  assert.equal(commandSucceeded({ error: new Error("inert"), signal: null, status: 0 }), false);
  assert.equal(commandSucceeded({ error: undefined, signal: "SIGTERM", status: null }), false);
  assert.equal(commandSucceeded({ error: undefined, signal: null, status: 1 }), false);
  assert.equal(commandSucceeded(null), false);
});

test("runner failure messages expose only a fixed internal step identifier", () => {
  for (const step of stage09pM0Steps) {
    assert.equal(fixedFailureMessage(step), `stage09p:m0 check FAIL ${step.id}\n`);
    assert(!fixedFailureMessage(step).includes("inert raw sentinel"));
  }
});
