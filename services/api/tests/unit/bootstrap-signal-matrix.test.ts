import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const expectedMatrixChecks = 106;

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

test("the signal matrix passes on the host shell", () => {
  const result = spawnSync("bash", [matrixScript, secretSourceScript], {
    encoding: "utf8",
    timeout: matrixTimeoutMs,
    env: { ...process.env },
  });
  assertMatrixPassed(result, "host signal matrix");
});

test("the signal matrix passes inside the pinned postgres 18.4 image as uid 999", () => {
  // 固定容器名 + finally 里的 `docker rm -f`：spawnSync 的 timeout 只会杀掉本地的
  // `docker` 客户端，容器本身照样在跑。没有这一步，一次超时就会留下一个孤儿容器。
  const containerName = "meal-agent-signal-matrix-gate";
  const forceRemove = (): void => {
    spawnSync("docker", ["rm", "--force", containerName], {
      encoding: "utf8",
      timeout: 30_000,
    });
  };
  forceRemove();
  let result;
  try {
    result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        containerName,
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
});
