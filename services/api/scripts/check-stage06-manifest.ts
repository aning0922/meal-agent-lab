import { checkAllStage06Adapters } from "./stage06-manifest-adapter.js";

/**
 * 阶段 09A / M2A：只读门禁。
 *
 * 内存渲染每个 generated adapter，与 tracked 文件逐字节比较。不一致时非零退出
 * 并给出重新生成的命令；**不会**自动改写文件。
 */

if (process.argv.slice(2).length > 0) {
  throw new Error("manifest:check takes no arguments");
}

const results = await checkAllStage06Adapters();
for (const result of results) {
  if (result.ok) {
    process.stdout.write(`manifest:check ${result.includePath}: ${result.detail}\n`);
  } else {
    process.stderr.write(
      `manifest:check ${result.includePath} failed: ${result.detail}\n`,
    );
  }
}
if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
