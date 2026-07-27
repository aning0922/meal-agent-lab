import { checkStage06ManifestAdapter } from "./stage06-manifest-adapter.js";

/**
 * 阶段 09A / M2A：只读门禁。
 *
 * 内存渲染 manifest adapter，与 tracked 的 generated 文件逐字节比较。不一致时
 * 非零退出并给出重新生成的命令；**不会**自动改写文件。
 */

if (process.argv.slice(2).length > 0) {
  throw new Error("manifest:check takes no arguments");
}

const result = await checkStage06ManifestAdapter();
if (!result.ok) {
  process.stderr.write(`manifest:check failed: ${result.detail}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`manifest:check passed: ${result.detail}\n`);
}
