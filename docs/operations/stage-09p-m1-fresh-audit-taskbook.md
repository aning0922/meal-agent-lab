# 阶段 09P-M1 全新动态审计任务书（M1D-1）

- 文档编号：09P-OPS-M1D1
- 日期：2026-09-12
- 上位依据：[ADR-0009：设计门禁的停止谓词与延迟项纪律](../../architecture/decisions/0009-review-acceptance-and-deferral-discipline.md)、
  [阶段 09P 计划](../../plans/2026-08-stage-09p-safe-deterministic-product-core.md) §12.1
- 对象：同一 M1 C2 候选（`codex/stage-09p-m1-household-safety`）的**纯 domain 动态**独立审计
- 状态：待产品负责人签发（本任务书不自行授权执行）

## 0. 本任务书的目的

本任务书用于闭合 M1 的 **B 腿**：对固定的 M1 C2 候选，运行**一次**全新命名、有界的纯 domain 动态审计，
取得当天之内的 `household-safety` TAP `292/292` 一手证据，从而给 B 腿一个可判定的结论。

三个必须逐字成立的命名与谱系约束：

1. 本次审计**是全新命名的**：正式名称为 **Fresh Audit M1D-1**（M1 Dynamic audit #1），
   报告文件名 `stage09p-m1-c2-household-safety-dynamic-audit-m1d1-<YYYYMMDD>.md`。
2. 本次审计**明确不是 `B-r4`**，不继承 `B-r1/r2/r3` 的轮次序号，也不得在任何文档中被称为
   `B-r4`、`B-r5`、`B 的新一轮` 或 `B 的补审`。
3. 本次审计**明确不是重试，也不是解除旧 BLOCK**：`B-r1`、`B-r2`、`B-r3` 永久保持各自
   `BLOCK / P0=0 / P1=0`，其报告、SHA 与结论不得被覆盖、修改、吸收、合并或改名。
   本次审计不重跑旧 B 的任何一条命令，只就该候选的 domain 动态语义重新取证。

## 1. 固定候选

- 仓库（权威工作树）：`/Users/aipuli/.codex/worktrees/stage09p-m1-household-safety`
- 分支：`codex/stage-09p-m1-household-safety`
- 候选 commit（必须精确为 40 位 SHA）：`8a69bc2435e1b7ebb3667d6bbea39ef5dffe81b8`
- tree：`bfa8d2901e099982de5f0f9ec218fb4562ac7839`
- sole parent：`0734aa885cb12ffce86a014c8c3dc58cf06d4ed5`
- tracked 文件数：`426`
- staged / unstaged / untracked：`0 / 0 / 0`（`git status --porcelain=v1 --untracked-files=all` 为空）

开工先核对上述六项；任一不匹配立即按 §8 的“审计执行失败”上报，不得进入动态序列。

## 2. 依赖投影（只读 node_modules）

动态测试用到的 `tsx` 与 `@noble/hashes` 由**权威依赖源**以只读方式投影，不在审计工作树内安装：

- 依赖源：`/Users/aipuli/.codex/worktrees/stage09p-m1-household-safety`（与候选同 HEAD/tree/parent/tracked）
- 固定 SHA-256（须逐字匹配，取自 B-r2 记录，作为本次依赖源的身份基线）：
  - `pnpm-lock.yaml`：`92e5d3c2d2ba7868c773fb877c9a6bb6e04b5fd963e4fee32becd90f6ec1c564`
  - `packages/domain/package.json`：`a6a806ce0ece6b108639d28d773283d7c4549a6c28b223a50399e2fd43f769a4`
  - `node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/package.json`：`116662201c06041c63de8837cf7bf6743f79a10187d0a210b377476071550a40`
  - `node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/package.json`：`ceb30ba96a14786c419db53f2b8d3d59ece7ac5221c198ac03def462cf96ef23`
- `packages/domain/node_modules` 必须是非 symlink 的真实目录，owner 为当前 uid。
- `packages/domain/node_modules/tsx`、`packages/domain/node_modules/@noble/hashes` 必须是 symlink，
  `readlink` 文本分别精确为：
  - `../../../node_modules/.pnpm/tsx@4.23.1/node_modules/tsx`
  - `../../../../node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes`
- 审计工作树的 `packages/domain/node_modules` 由审计者自行建立一条指向依赖源的投影链接，
  其存在性、类型、owner 与 ignored status 须在 PRE/POST 记录。

若签发人改为要求“在审计内完成一次离线 `pnpm install`”而不是只读投影，则 §7 修正 1 生效，
且投影证据改为 store 证据；两者**只能择一，并由签发人在签发时钉死**，不得在审计中途切换。

## 3. 纪律

- 候选 tracked 文件、依赖源、报告目录一律**只读**；不提交、不推送、不合并、不建 PR、不标 Accepted。
- 本审计是**全新、独立、互盲**的会话；**不得读取 Audit A 的任何任务、消息或报告**
  （Audit A 报告为 `stage09p-m1-c2-limited-acceptance-fresh-audit-a-20260903.md`，
  SHA-256 `2830046347cc2c8a2a206676bc10cabc3473144e59c943e0b43e54d452312cb4`），
  不得接收或使用其结论。
- 不得创建、调用或委派 subagent/subtask；不得与其他审计角色协作。
- 一旦进入动态序列，遵守**零 retry**：同一条命令只执行一次；不得改环境、改 PATH、改 store、
  改 sandbox 策略、提权或换命令后重试。
- 严禁 Docker / Docker Compose / smoke / restore / lifecycle；严禁
  `stage08:check` / `stage09a:check` / `stage09p:check` / G2 / compatibility witness /
  repository sweep / docs gate；严禁网络、真实数据、真实食品事实导入、数据库/API/UI 运行。
- 唯一允许的动态命令是 §6 的 domain 测试及其前置的只读身份核对。临时资源只放私有根，
  按精确路径登记，不 cleanup（保留制品须逐条披露）。

### 3.1 工具解析（本版新增；源自 M1D-1 与 M1D-2 两次执行失败）

**不得硬编码 `/usr/bin/<tool>` 或 `/bin/<tool>`。** 本机（macOS）工具分布在两个目录里，
任选一个前缀都必然有一批工具不存在，而 `set -eu` 下第一个不存在的二进制就会让整条序列
静默中断——这正是 M1D-2 的失败形态（预检已全部通过，动态序列却在第一个命令上 exit 127）。

本机实测分布（2026-09-12）：

| 只在 `/bin` | 只在 `/usr/bin` |
| --- | --- |
| `ln`、`mkdir`、`realpath`、`pwd`（内建） | `wc`、`tr`、`stat`、`git`、`env`、`shasum`、`readlink`、`basename`、`dirname` |

强制做法：**在 §6 Step 1 之前**，对本次审计将用到的每一个工具执行一次
`command -v <tool>`，把解析出的绝对路径登记成一份**工具清单**，并断言每个都 `-x` 可执行。
此后所有命令一律使用清单里登记的那条路径（或直接使用已解析的名字），不得再出现硬编码前缀。

**任一工具解析失败即停止并报 `AUDIT_EXECUTION_FAILURE`**，不得改用未登记路径继续、不得猜测。

历史两次执行失败（均为协议侧缺陷，非产品缺陷，均未被计为 BLOCK）：
- **M1D-1**：依赖准备被钉为路径 B，其预暖步骤需要联网，而本环境拒绝 `registry.npmjs.org`
  出网。该次同时**证明了修正 1 有效**——私有根内的 store 目录与其 SQLite index 确实建成了。
  处置：签发人把依赖准备改钉为**路径 A（只读投影）**，后者不需要网络。
- **M1D-2**：路径 A 在预检中**已成功建立并核对**（四项 SHA、两项 readlink、六项身份锚全对），
  但动态序列使用了 `/usr/bin/ln` 建投影链接，该路径在本机不存在（`ln` 在 `/bin/ln`），
  exit 127 后停止。处置：新增本节。

## 4. 必读

完整阅读并核对：

- `AGENTS.md`、根 `README.md`、`docs/README.md`、`docs/project-status.md`；
- `docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md` §12.1、§12.3；
- `docs/architecture/decisions/0009-review-acceptance-and-deferral-discipline.md`；
- 候选内 `packages/domain/src/resolution.ts`（尤其 `evaluateHouseholdDishSafety`）与
  `packages/domain/tests/household-safety.test.ts`；
- 候选内 `data/reference/ingredients/stage09p-m1-household-safety-source-pack.json`
  （仓库根 `data/` 下，**非** `packages/domain/data/`——该目录不存在）。

**不必读、不得读**：Audit A 报告、ordinary full gate 报告的 `292/292` 文本不得作为本次结论的替代——
本次 TAP 必须由本审计自己运行产生。

## 5. 审计重点（必须由本次一手动态证据证明）

运行指定测试并逐条确认下列固定语义没有被动态推翻：

1. active 家庭成员的过敏为**整桌 hard**（不是仅该成员）；
2. 宗教 / 伦理 / strict avoid 为**个人 hard**；
3. 普通 avoid / dislike / reduce 为 **soft**；
4. inactive / archive 的档案**不贡献当前 hard**；
5. **unknown fail closed**（未知不等于安全，也不等于否）；
6. active source pack 的 trust allowlist 为空时**不返回 allowed**；
7. synthetic / draft 数据**不冒充**已发布真值；
8. guest / family、precedence、canonical digest 与 seven-module boundary 保持不变。

同时核对：唯一 source pack 的 `lifecycleStatus` 仍为 `draft`；`resolution.ts` 的 trust allowlist
仍为空数组；只有 `__testOnly*` 合成 seam 能走到结论。任何一条被动态推翻即为确认级缺陷，按 §8 BLOCK。

## 6. 唯一动态序列

### Step 1 — 私有临时根（PASS 前置）

```zsh
set -e
audit_root=/private/tmp/stage09p-m1-c2-household-safety-dynamic-audit-m1d1-<YYYYMMDD>
if [[ -e "$audit_root" ]]; then print -u2 -- AUDIT_ROOT_ALREADY_EXISTS; exit 73; fi
/bin/mkdir -m 0700 "$audit_root"
/bin/mkdir -m 0700 "$audit_root/home" "$audit_root/tmp" "$audit_root/pnpm-cache"
/usr/bin/stat -f "%Sp %N" "$audit_root" "$audit_root/home" "$audit_root/tmp" "$audit_root/pnpm-cache"
```

### Step 2 — 固定 runtime

```zsh
<CLOSED_ENV> /Users/aipuli/.nvm/versions/node/v24.18.0/bin/node --version   # 期望 v24.18.0
<CLOSED_ENV> /Users/aipuli/.nvm/versions/node/v24.18.0/bin/pnpm --version   # 期望 11.9.0
```

`<CLOSED_ENV>` 精确为下列单行前缀（沿用旧 B 的封闭环境，**但 store 指向私有根内**，见 §7 修正 1）：

```text
/usr/bin/env -i HOME=/private/tmp/stage09p-m1-c2-household-safety-dynamic-audit-m1d1-<YYYYMMDD>/home TMPDIR=/private/tmp/stage09p-m1-c2-household-safety-dynamic-audit-m1d1-<YYYYMMDD>/tmp PNPM_CONFIG_CACHE_DIR=/private/tmp/stage09p-m1-c2-household-safety-dynamic-audit-m1d1-<YYYYMMDD>/pnpm-cache PNPM_CONFIG_STORE_DIR=/private/tmp/stage09p-m1-c2-household-safety-dynamic-audit-m1d1-<YYYYMMDD>/pnpm-store DEVELOPER_DIR=/Library/Developer/CommandLineTools PATH=/Users/aipuli/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin COREPACK_HOME=/Users/aipuli/.cache/node/corepack COREPACK_ENABLE_NETWORK=0 COREPACK_DEFAULT_TO_LATEST=0 PNPM_CONFIG_OFFLINE=true PNPM_CONFIG_IGNORE_SCRIPTS=true NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/dev/null npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null LC_ALL=C LANG=C
```

没有 `GIT_*`、proxy、registry、credential、SSH、XDG、loader 或 `NODE_OPTIONS`。

### Step 3 — 依赖准备（择一，由签发人钉死）

- **路径 A（只读投影，推荐）**：在审计工作树建立 `packages/domain/node_modules` 投影链接，
  指向 §2 的依赖源，并核对 §2 的四个 SHA 与两个 `readlink` 文本。不运行任何 install。
- **路径 B（私有根内离线 install）**：按 §7 修正 1 的**预暖 + 修正命令**执行一次离线
  `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir <audit_root>/pnpm-store`。

任一 `exit_code != 0` 且非确认级产品缺陷时，按 §8 上报“审计执行失败”，不得 retry。

### Step 4 — 指定 domain test（唯一动态写入）

```text
workdir=<audit_worktree>/packages/domain
<CLOSED_ENV> /Users/aipuli/.nvm/versions/node/v24.18.0/bin/node --import tsx --test tests/household-safety.test.ts
```

仅一次。期望 exit_code 0，TAP 汇总为：

| Marker | 要求 |
| --- | ---: |
| `# tests` | `292` |
| `# pass` | `292` |
| `# fail` | `0` |
| `# cancelled` | `0` |
| `# skipped` | `0` |
| `# todo` | `0` |
| completion | 明确完成 |
| exit code | `0` |

### Step 5 — POST 只读核对

```zsh
<CLOSED_ENV> /usr/bin/git status --porcelain=v1 --untracked-files=all
<CLOSED_ENV> /usr/bin/git rev-parse HEAD
<CLOSED_ENV> /usr/bin/git rev-parse 'HEAD^{tree}'
<CLOSED_ENV> /usr/bin/git rev-list --parents -n 1 HEAD
<CLOSED_ENV> /bin/zsh -c '/usr/bin/git ls-files | /usr/bin/wc -l'
```

HEAD / tree / sole parent / tracked 计数须与 PRE 完全一致，porcelain 为空。

## 7. 三项工具缺陷的精确修正

以下三项是 `B-r1/r2/r3` 各自 BLOCK 的**审计执行**根因（都不是产品缺陷）。本次审计的命令必须
逐字采用修正后的形式；若签发人另有等价形式，须在签发时钉死。

### 修正 1 — pnpm store index 无法打开（`B-r1`）

- 失败命令（B-r1 §4 Step 3，`exit_code=1`）：

  ```zsh
  /Users/aipuli/.nvm/versions/node/v24.18.0/bin/pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir /Users/aipuli/Library/pnpm/store/v11
  ```

- 失败输出：`[ERR_SQLITE_ERROR] unable to open database file`（`StoreIndex.openDatabase`）。
- 失败原因：store 被钉在**包含环境之外**的 `~/Library/pnpm/store/v11`，而审计把 `HOME`/`TMPDIR`
  都重定向进了私有根；包含环境因此无法打开（创建/加锁）store 的 SQLite index `index.db`；
  且该 store 未针对离线安装**预暖**。
- 修正要求：**store 必须钉在审计包含环境内可写的路径（私有根内），并在审计开始前预暖。**
- 修正命令（Step 1 追加创建 + 审计前一次性预暖 + 审计内离线 install）：

  ```zsh
  # Step 1 追加：
  /bin/mkdir -m 0700 "$audit_root/pnpm-store"

  # 预暖（环境准备，审计动态序列开始之前执行一次；有网环境；记录其精确命令与产物）
  /usr/bin/env -i HOME="$audit_root/home" TMPDIR="$audit_root/tmp" \
    PNPM_CONFIG_CACHE_DIR="$audit_root/pnpm-cache" PNPM_CONFIG_STORE_DIR="$audit_root/pnpm-store" \
    DEVELOPER_DIR=/Library/Developer/CommandLineTools \
    PATH=/Users/aipuli/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin \
    COREPACK_HOME=/Users/aipuli/.cache/node/corepack \
    NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/dev/null \
    npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null LC_ALL=C LANG=C \
    /Users/aipuli/.nvm/versions/node/v24.18.0/bin/pnpm install \
      --frozen-lockfile --ignore-scripts --store-dir "$audit_root/pnpm-store"

  # 审计内离线 install（唯一一次）：
  <CLOSED_ENV> /Users/aipuli/.nvm/versions/node/v24.18.0/bin/pnpm install \
    --offline --frozen-lockfile --ignore-scripts --store-dir "$audit_root/pnpm-store"
  ```

- PRE 须登记 store 证据：`stat -f '%Sp' "$audit_root/pnpm-store"`、
  `shasum -a 256 "$audit_root/pnpm-store/index.db"`、store 内文件计数。
- 若签发人改选 §6 Step 3 的**路径 A（只读投影）**，则本修正不适用，PNPM store 相关命令一律不执行。

### 修正 2 — `/usr/bin/realpath` 在本机不存在（`B-r2`）

- 失败命令（B-r2 §“精确工具调用 1”，`exit_code=127`）：

  ```zsh
  tsx_resolved=$(/usr/bin/realpath "$src_tsx_link")
  noble_resolved=$(/usr/bin/realpath "$src_noble_link")
  ```

- 失败输出：`zsh:67: no such file or directory: /usr/bin/realpath`。
- 失败原因：本机（macOS）没有 `/usr/bin/realpath`，脚本以 `set -eu` 运行，故后续汇总与全部断言
  之后的检查均未执行。
- 修正要求：**改用本机存在的等价命令**，不得调用 `realpath`。
- 修正命令：

  ```zsh
  tsx_resolved=$(cd -P -- "$src_tsx_link" && /bin/pwd -P)
  noble_resolved=$(cd -P -- "$src_noble_link" && /bin/pwd -P)
  ```

  （等价的物理路径求法亦可，但必须在报告中写明所用命令，并声明“未调用 `/usr/bin/realpath` 或任何
  `realpath`”。）

### 修正 3 — tracked 计数误用 `wc -c` 统计字节（`B-r3`）

- 失败命令（B-r3 PRE-1，输出 `tracked=17254`，`exit_code=1`）：

  ```zsh
  tracked=$(/usr/bin/git ls-files -z | /usr/bin/wc -c | /usr/bin/tr -d ' ')
  ```

- 失败原因：`git ls-files -z` 输出的是 **NUL 分隔的记录流**，`wc -c` 统计的是该字节流的**字节数**，
  不是记录条数；`17254` 是字节数，不能作为 tracked-file 计数证据。
- 修正命令（期望输出 `426`）：

  ```zsh
  tracked=$(/usr/bin/git ls-files | /usr/bin/wc -l | /usr/bin/tr -d ' ')
  ```

## 8. 失败分类：产品缺陷 vs 审计执行失败（本次审计相对旧协议新增的判定）

旧 B 协议只有一条根规则——“任一 PRE 失败即零 retry、零 test”，但它没有区分**失败的类别**，
以致三次纯粹的环境/工具事故被冻结成永久 BLOCK。本次审计必须明确区分：

| 类别 | 定义 | 判定 | 审计者必须做什么 |
| --- | --- | --- | --- |
| **确认级产品/运行时缺陷** | domain 测试**实际运行**并暴露一条被确证的语义失败（§5 任一条被推翻），或候选身份与固定值不匹配（HEAD/tree/parent/tracked/SHA 漂移） | **BLOCK**，零 retry，永久 | 写出确认级 finding（严重度、绝对文件/行、最小反例、真实结果、归因、阻断性、修复判别标准），结论 `BLOCK` |
| **纯环境 / 工具失败** | 缺失的二进制、不可写的 store、写错的计数命令等**与产品语义无关**的执行事故 | **不是 BLOCK**；记为**审计执行失败（AUDIT_EXECUTION_FAILURE）** | 立即 STOP，输出失败报告并**停止**，不得 retry、不得自改命令；由签发人修复后**签发一份全新审计** |

**关键点**：

- 纯环境/工具失败**不得**被写进永久 BLOCK，不得计入 `P0`/`P1`，不得被叙述成产品发现。
- 纯环境/工具失败的报告必须写明：失败的**精确命令**、**精确错误文本**、`exit_code`、失败**类别**
  （缺二进制 / store 不可写 / 计数命令写错），以及“未进入动态序列”。
- 本规则**只向前适用**：`B-r1/r2/r3` 的历史 BLOCK **保持原样**，不因本节的分类而重判或改名。
- 在审计**内部**仍为零 retry（一条命令只跑一次，不自改命令）；可修复性体现在“签发一份新审计”，
  而不是“在同一份审计里重试”。

## 9. 独立性要求

- **全新 detached worktree**：本次审计须在一个全新的 git worktree（detached、钉在 §1 的
  commit）中执行；该 worktree 的 `git-dir` 不得是主 checkout 的 `.git`。
- **精确候选身份**：HEAD / tree / sole parent / tracked 计数四项在 PRE 与 POST 均须与 §1 逐字一致。
- **只读候选**：PRE 与 POST 的 `git status --porcelain=v1 --untracked-files=all` 均为空；
  不得修改 tracked 字节、Git index/refs/history。
- **PRE/POST 身份证据**：按 §6 Step 1–5 与 §7 的修正命令采集；PRE、POST 记录须逐条列出命令与原始输出。
- **输出落点**：唯一持久输出写入
  `/Users/aipuli/Documents/Projects/meal-agent-lab/.local/audit-reports/stage09p-m1-c2-household-safety-dynamic-audit-m1d1-<YYYYMMDD>.md`。
- **互盲**：不得读取 Audit A 的任何材料（见 §3）。

## 10. 裁定与报告格式

- 任一确认级 `P0` / `P1` → `BLOCK`。
- `P2` 单列，交总控裁定。
- 只有确认级发现为零**且** TAP 达到 §6 Step 4 的全部 marker（含 `292/292`、`fail=0`、`cancelled=0`、
  `skipped=0`、`todo=0`、`exit_code=0`）才可 `CLEAN`。
- 每条 finding 必须包含：严重度、绝对文件/行、最小反例、真实结果、归因、阻断性、修复判别标准。
- 报告还须列出：已执行 / 未执行项目清单、临时资源与保留制品、最终 Git 状态，
  并明确 Docker 为“未运行”。

## 11. 上限（ceiling）

- `B CLEAN`（本次 M1D-1 CLEAN）**不是 `M1 Accepted`**，也不是 `M1 technical CLEAN`。
- M1 的接受还缺**外部审查腿**：计划 §3.4 成功定义、§4.5 外部高准确性审查结论、12 名具名角色
  与 G2 admission——这些都不在本次纯 domain 动态审计的范围内，本次结论不能回填它们。
- `B-r1 / B-r2 / B-r3` **永久保持 BLOCK**，本审计 CLEAN 不改变其状态，也不可被叙述为“B 腿已全部闭合”。
- 本审计不补写：`G2`（仍 `G2_NOT_ADMITTED`）、standard Stage09A `14/14`（仍 step 9 BLOCK）、
  Audit A、release、publication、activation、merge、push。
- 任何把 `B CLEAN` 当作 `M1 Accepted` 的叙述都属语义缺陷，须立即停止。

## 12. 停止条件

- 出现确认级产品/运行时缺陷 → `BLOCK`，零 retry，停止；
- 出现纯环境/工具失败 → `AUDIT_EXECUTION_FAILURE`，停止，等待签发人修复后**另签新审计**；
- 再次因工具而非确证的运行时缺陷而“BLOCK” → 说明零 retry 规则需经**记录在案的决定**修订，
  不得继续自动生成新的审计；
- 若切片/动态证据表明引擎无法读取未脱敏约束，或以 `displayName` 字串而非 `foodConceptId` 连接库存
  → 与本次 domain 审计无关，但也属阻断信号，须上报总控。
