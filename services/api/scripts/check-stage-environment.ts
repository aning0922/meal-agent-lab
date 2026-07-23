import {
  assertStageNodeVersion,
  findPostgres18Bin,
} from "./stage-environment.js";

assertStageNodeVersion();
const postgres = await findPostgres18Bin();
process.stdout.write(
  `Stage 06 environment ready: Node.js ${process.versions.node}; ${postgres.version}\n`,
);
