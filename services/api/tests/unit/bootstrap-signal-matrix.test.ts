import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * 阶段 09A / M3A：`secret-source.sh` 信号矩阵的**容器门禁**。
 *
 * 同一份 `infra/docker/postgres/signal-matrix.sh` 在两个地方跑：
 *
 *   - 本机（macOS / bash 3.2），由下面第一条用例直接执行；
 *   - 钉住 digest 的 `postgres:18.4-bookworm`（Debian / bash 5.2）里以 **uid 999**
 *     执行，由第二条用例执行——那才是 bootstrap 真正运行的环境。
 *
 * 之所以要两侧都跑：信号语义、`trap -p` 的输出格式、进程组行为在 bash 3.2 与 5.2
 * 之间并不完全一致，只在开发机上绿不能代表容器里也对。这一条以前只写在文档里，
 * 现在是门禁。
 *
 * **前置条件**：第二条用例需要能运行 Docker。它是**硬要求**，不做静默跳过——
 * 一条会自动跳过的安全用例等于没有。阶段 09A 的本地部署基线本来就以 Docker 为
 * 前提（Compose 拓扑、固定镜像 digest 都在同一阶段）。
 */

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const matrixScript = join(
  repositoryRoot,
  "infra/docker/postgres/signal-matrix.sh",
);
const secretSourceScript = join(
  repositoryRoot,
  "infra/docker/postgres/secret-source.sh",
);

/**
 * 与 `infra/docker/compose.local-test.yaml` 完全一致的固定 digest。拓扑门禁会
 * 保证 Compose 那边不漂移；这里再钉一次，是为了让「门禁跑的就是部署跑的那个
 * 镜像」这件事不依赖任何隐式约定。
 */
const pinnedPostgresImage =
  "docker.io/library/postgres:18.4-bookworm@sha256:" +
  "1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296";

/**
 * 矩阵的断言条数**精确钉住**。
 *
 * 原来写的是 `>= 80`：一条下界既拦不住「悄悄删掉几条」，也让文档里的覆盖矩阵
 * 无从核对。改成精确值之后，任何增删都必须同时改这里和文档，漂移会立刻变红。
 */
const expectedMatrixChecks = 150;

/** 矩阵自身每个 case 有 25 秒看门狗；外层再给一个宽裕但**有界**的上限。 */
const matrixTimeoutMs = 180_000;

const assertMatrixPassed = (
  result: ReturnType<typeof spawnSync>,
  label: string,
): void => {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(
    result.error,
    undefined,
    `${label}: could not run the matrix: ${String(result.error)}`,
  );
  assert.equal(
    result.signal,
    null,
    `${label}: the matrix was killed by ${String(result.signal)}\n${output}`,
  );
  assert.equal(result.status, 0, `${label} failed\n${output}`);
  // 正向断言：不能靠「一条检查都没跑」拿到退出码 0。
  const summary = /signal-matrix: (\d+) checks, (\d+) failure\(s\)/.exec(
    output,
  );
  assert.ok(summary, `${label}: no matrix summary line\n${output}`);
  assert.equal(Number(summary[2]), 0, `${label}: ${output}`);
  assert.equal(
    Number(summary[1]),
    expectedMatrixChecks,
    `${label}: expected exactly ${String(expectedMatrixChecks)} checks, got ` +
      `${String(summary[1])}; update both this number and the coverage matrix in\n` +
      `  docs/project-status.md and infra/docker/postgres/README.md\n${output}`,
  );
};

/**
 * 当前系统里 `sleep <n>` 的进程数。
 *
 * 矩阵每个 case 都会起一个睡 25 秒的看门狗。只 kill 看门狗自己会把那个 `sleep`
 * 留下来——它会一直挂到自然醒。矩阵内部已经逐个断言过，这里从**外部**再确认一次：
 * 矩阵结束的那一刻，系统里不能因为它而多出任何一个 `sleep 25`。
 */
const sleepProcessCount = (seconds: number): number => {
  const listed = spawnSync("ps", ["-A", "-o", "args="], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (typeof listed.stdout !== "string") {
    return 0;
  }
  return listed.stdout
    .split("\n")
    .filter((line) => line.trim() === `sleep ${String(seconds)}`).length;
};

/** 与 `signal-matrix.sh` 里的 `meal_agent_case_watchdog_seconds` 一致。 */
const watchdogSeconds = 25;

test("the signal matrix passes on the host shell and leaves no watchdog sleep", () => {
  const before = sleepProcessCount(watchdogSeconds);
  const result = spawnSync("bash", [matrixScript, secretSourceScript], {
    encoding: "utf8",
    timeout: matrixTimeoutMs,
    env: { ...process.env },
  });
  assertMatrixPassed(result, "host signal matrix");
  // 立刻数——不给任何「等它自然醒」的余地。
  const after = sleepProcessCount(watchdogSeconds);
  assert.ok(
    after <= before,
    `the matrix must not leave watchdog sleeps behind: ${String(before)} -> ${String(after)}`,
  );
});

test("the signal matrix passes inside the pinned postgres 18.4 image as uid 999", () => {
  // 容器名必须**按本次运行唯一**：worktree 可以并行、同一台机器上也可能同时跑
  // 两条门禁。一个写死的名字会让后开的那个直接名字冲突，更糟的是 `docker rm`
  // 会去删**别人的**容器。
  //
  // 因此名字里带 pid 与 worktree 路径的摘要，并且清理只按**本次的 ownership
  // label** 来删——不按名字模糊匹配，也不碰任何没有这个 label 的容器。
  const ownershipId = randomUUID();
  const worktreeDigest = createHash("sha256")
    .update(repositoryRoot)
    .digest("hex")
    .slice(0, 12);
  const containerName = `meal-agent-signal-matrix-${String(process.pid)}-${worktreeDigest}`;
  const ownershipLabel = `meal-agent.signal-matrix.run=${ownershipId}`;
  const forceRemove = (): void => {
    const listed = spawnSync(
      "docker",
      ["ps", "--all", "--quiet", "--filter", `label=${ownershipLabel}`],
      { encoding: "utf8", timeout: 30_000 },
    );
    const ids = (listed.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const id of ids) {
      spawnSync("docker", ["rm", "--force", id], {
        encoding: "utf8",
        timeout: 30_000,
      });
    }
  };
  let result;
  try {
    result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        containerName,
        "--label",
        ownershipLabel,
        // PID 1 收养并回收孤儿：矩阵自己已经按进程组清理，`--init` 是最后一道
        // failure-safe，保证即使矩阵被外部打断也不会在容器里留下僵尸。
        "--init",
        // bootstrap 在 Compose 拓扑里就是以 uid 999 跑的；权限判据（属主必须等于
        // effective uid）只有在同一个 uid 下才有意义。
        "--user",
        "999:999",
        "--network",
        "none",
        "-v",
        `${secretSourceScript}:/srv/secret-source.sh:ro`,
        "-v",
        `${matrixScript}:/srv/signal-matrix.sh:ro`,
        "-e",
        "TMPDIR=/tmp",
        pinnedPostgresImage,
        "bash",
        "/srv/signal-matrix.sh",
        "/srv/secret-source.sh",
      ],
      { encoding: "utf8", timeout: matrixTimeoutMs },
    );
  } finally {
    forceRemove();
  }
  assertMatrixPassed(result, "pinned-image signal matrix");
  assert.ok(
    /bash, version 5\./.test(`${result.stdout}`),
    `the pinned image must really be the Debian bookworm bash 5 side\n${result.stdout}`,
  );
  // 带本次 ownership label 的容器一个都不能剩。
  const remaining = spawnSync(
    "docker",
    ["ps", "--all", "--quiet", "--filter", `label=${ownershipLabel}`],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(
    (remaining.stdout ?? "").trim(),
    "",
    "no container carrying this run's ownership label may survive",
  );
});
