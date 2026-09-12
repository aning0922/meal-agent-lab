# 09P 递延项登记表（deferral register）

## 目的

09P 设计门禁此前的停止谓词**无界**：它把「评审剩余发现数为零」当作收敛判据，而这个量由
过程自己不断再生；修订协议又只补被点名的那一处、不回读同一主张的兄弟句，于是每修一处就
制造下一轮。把「暂时不做」从散落在计划、证据与开放问题里的散文，收拢成一份**可机读、
缺字段即转红**的登记，是收敛的第一步。

本目录承载两份东西：

- `deferral-register.json`：登记表本体（严格 JSON，无注释）。
- 本 README：登记口径与闸门口径。

登记表**不是**新的架构决策，也不改写任何既有结论。它只把已经存在的递延/未闭合项，逐条
扣上六个必填字段（含内容准入类别 `admissionBasis`），使「它还在开着」这件事**无法被静默遗忘**。

## 字段：主键 + 六字段

每一笔登记**恰好**携带主键 `id` 与下列**六个**字段（多一个、少一个都转红）：

| 字段 | 含义 | 取值约束 |
| --- | --- | --- |
| `owner` | 对该项负责的具名责任主体：具名个人，或 M2 gap-gate §4 定义的责任角色；无人负责时写哨兵 `unassigned:<理由>` | 非空；哨兵须带非空理由 |
| `closesAtModule` | 闭合模块或外部方 | 必须落在闭合模块集内，或为外部哨兵 `external` |
| `evidenceNeeded` | 闭合所需的最小真实证据 | 非空字符串 |
| `closeTrigger` | 触发闭合/复评的事件或时点 | 非空字符串 |
| `expiry` | 到期日 | 带时区偏移的 ISO 8601，或哨兵 `unassigned:<理由>` |
| `admissionBasis` | 内容准入类别 | `bookkeeping` / `open-design-question` / `evidence-obligation` |

子段键名一律 camelCase（与 checker 的键集一致；不使用 `closes-at-module` 之类的连字符键名）。
`id` 是主键：非空、形状受限、全表唯一。

### 闭合模块闭集

`closesAtModule` 只接受以下取值，或外部哨兵 `external`：

`identity/G-ID`、`client/G-CLIENT`、`backend/G-BACKEND`、`source/G2`、
`security/ADR-0004`、`migration/DB`、`wp-o4/maintainer`、`governance/总控`、
`m4a/entitlement`、`m4a/guest-facts`、`m4a/serving-substitution`、`m4a/client-meal-confirm`。

新增闭合模块必须显式改动 `scripts/check-deferral-register.mjs` 的
`KNOWN_CLOSES_AT_MODULES`；若闭合方在仓库外，用 `external` 哨兵。这样任何写错模块名的
条目都会在闸门转红，而不是被当成「一个新模块」默默放行。

### expiry 与 `unassigned:<理由>` 哨兵

`expiry` 沿用 `security/audit-exceptions.json` 的口径：到期日是**带时区**的全 ISO 8601
（例如 `2026-11-08T23:59:59+08:00`），闸门用正则校验格式并断言其可解析；到了那一天由
另行决议处理，**禁止静默续期**。

今天确实还没有到期日的条目，**不得留空**，必须显式写哨兵 `unassigned:<理由>`——**理由
不可省略**。哨兵比留空更严格：

- 缺字段或空串 → 转红（`EXPIRY_MISSING`）；格式非法 → 转红（`EXPIRY_MALFORMED`）。
  **裸 `unassigned`（无理由）与空理由（`unassigned:   `）都判 `EXPIRY_MALFORMED`**。
- `unassigned:<理由>` **被计数、逐条上报**（stdout 的
  `deferral register unassigned-expiry <id>` 行 + 摘要行里的 `unassignedExpiry` 与
  `unassignedIds`），并与顶层声明的 `unassignedExpiryCount` **硬比对**。把某一笔从
  `unassigned:<理由>` 悄悄改成真实日期、或反过来，都会让计数不符而转红（`UNASSIGNED_COUNT`）。
- **有界**：顶层 `reviewByMilestone`（当前 `M2`）声明下一个里程碑收口；每条
  `unassigned:<理由>` 条目**不得跨过该收口**——到达收口时每条必须逐条转为真实日期或
  明确关闭，否则该收口不得判为通过。带理由的哨兵是「有界等待」，不是无限期停放场。
- 顶层 `expectedEntryCount` 与 `entries.length` 硬比对（`ENTRY_COUNT`），静默删除条目会被抓住。
- **重复成员**：`JSON.parse` 会把同一对象内的重复键静默折叠为最后一个值，故闸门在解析前
  对原文另做一次键扫描（`findDuplicateKeys`），且键按**解码后的值**比较（同一键的 unicode
  转义写法与字面量写法解码后相等、属同一键）；出现重复成员即转红（`DUPLICATE_KEY`）。

## 准入规则：按内容类别，绝不按 P 标签

一笔递延是否**允许存在**，只取决于它属于哪一类**内容**，与它当初被评成 P0/P1/P2 无关。
每笔必须显式声明其 `admissionBasis`，且只能是下列三类之一（与 ADR-0009 §3 一致）：

| `admissionBasis` | 含义 |
| --- | --- |
| `bookkeeping` | 纯记账：行号、字节/行计数、表头，以及**不误导读者**的出处/交叉引用更正（循缺陷引用与循改正引用推出的必需行为一致） |
| `open-design-question` | 尚未作出设计决定的开放设计问题（非一处已知缺陷），如 Q10 的版本边界机制 |
| `evidence-obligation` | 语义修复**已落地**、仅差真实证据的命名义务（如 O9-5/G8 的 non-reuse 义务）；登记后**保持 admission blocker**，且 `closeTrigger` 必须写明该措辞（checker 核验） |

尤其要守住的两条边界：

- **出处/交叉引用更正是否算 `bookkeeping`，判据是误导，不是「改正后的引用是否承载内容」**：
  一条更正算记账，当且仅当**循着有缺陷的引用与循着改正后的引用所推出的必需行为完全一致**；
  若错误引用会把读者引向另一条规范规则，该缺陷即误导读者，属语义修复、**必须本轮修复**、
  不得入表（实例：WP-O3 §15 的 AUTH-P2-01，把 `WP-O1 §6.2(3)` 改为 `§6.2(1)`，改正后的
  §6.2(1) 确实承载 fail-closed 规则，但原引用的 §6.2(3) 恰是相反分支，读者会推出相反
  行为，属语义修复而非记账）。
- 本登记表与它所属的收敛规则**不得**因为「某发现被标成 P2」就把它降级为可递延。恰恰相反
  ——0/0/0 实践曾抓到真实的 fail-open 缺陷且其中若干被标为 P2（例如 R2-ADV-03：
  `identityPolicyVersion` 是身份键的成员，版本一变命名空间即移动，旧 non-reuse landmark
  便不再覆盖，属攻击面 (d)），它**正是因为 P2 计入阻断才被修**。

**不得绕过的硬边界**：三类 `admissionBasis` **不得**用来递延一处**已知的、未修复的**语义
缺陷。任何已知缺陷只要其修复会触碰规范性内容（must / shall / only / never、invariant、
fail-closed、identity、namespace、authority、key、binding、entitlement），就**无论其 P 标签
为何都必须本轮修复**；`evidence-obligation` 只适用于「修复已落地、仅余证据」，绝不能把
「发现」与「尚未取得的证据」之间的边界当作降低阻断级别的通道。任何弱化设计门禁阻断语义
缺陷能力、或全局降级 P2 的做法，均超出本表授权。

## 登记不等于闭合

把一笔写进登记表，**只**表示它被如实记账、带着六字段义务公开可见；它**不**表示该项已
闭合、已豁免、或已从阻断中移出。具体口径：

- 登记**不**降低阻断级别：`evidence-obligation` 类条目（如 O9-5/G8）在证据取得并解除前
  **保持 admission blocker**，不因其 `admissionBasis` 或 P 标签而被移出阻断。
- 登记不是 gate closed：例如 O9-5 在 Q10 关闭前仍是 admission blocker，登记它不等于解除它。
- 登记不是新证据：`evidenceNeeded` 描述的是**尚未取得**的证据，表格中不留任何「已取得」的暗示。
- 登记不改状态：候选、Proposed、待验证、Deferred 与已知边界各自成态，不因进入本表而升级。

结论上限语言同样适用：本表与相关文档不得把任何候选写成 gate closed / implementation-ready /
CONTRACT_FROZEN；上限止于 `DESIGN_ONLY` 或 `READY_FOR_FRESH_REVIEW`。

## 出处与边界

- 六字段义务与停止谓词、里程碑级轮次上限（同一设计线在同一里程碑内至多 3 轮，按里程碑
  身份 M0—M6 计数、不按任务/阶段重置）的规范落点，是 09P 线的规则
  [ADR-0009：设计门禁的停止谓词与延迟项纪律](../architecture/decisions/0009-review-acceptance-and-deferral-discipline.md)
  （`Accepted`，落于 `docs/architecture/decisions/`）；本登记表是该规则的可机读附录。
- 关联计划：[2026-08-stage-09p-safe-deterministic-product-core.md](../plans/2026-08-stage-09p-safe-deterministic-product-core.md)。
- 上一枚 09P ADR：[ADR-0008：Stage 09P-M0 产品证据边界](../architecture/decisions/0008-stage09p-m0-evidence-boundary.md)；
  ADR 索引见 [decisions/README.md](../architecture/decisions/README.md)。
- `expiry` 的唯一既有模型：[security/audit-exceptions.json](../../security/audit-exceptions.json)
  （`acceptedAt` 日期 + `expiresAt` 带 `+08:00` 的全 ISO，逾期 fail closed，禁止静默续期）。
- 每笔登记的上游出处（逐字出处：O9-5 之于 WP-O3 §7.2.3/§11 RA-27，AUTH-R5-01/02 之于
  wp-o4-fresh-review §3，等等）写在对应决策包与证据 README 中；登记表只承载主键与六字段。

## 如何运行闸门

```sh
# 单个闸门（读固定路径 docs/governance/deferral-register.json）
node scripts/check-deferral-register.mjs
# 或经根脚本（见 package.json）
pnpm stage09p:deferral:check

# 单元测试（真实登记表 + 定点变异，含 CLI 诊断边界）
node --test scripts/tests/deferral-register.test.mjs
```

闸门行为：

- 通过：stdout 打固定行 `deferral register check passed`，随后逐条
  `deferral register unassigned-expiry <id>` 与 `deferral register unassigned-owner <id>`
  （仅为上报），末行是机器可读摘要 `deferral-register summary <json>`；退出码 0。
- 失败：逐条 `deferral register FAIL <code> <pointer>` 打 stderr，末行同款摘要；退出码 1。
  失败码含 `ENTRY_KEYS`、`OWNER_EMPTY`、`OWNER_UNASSIGNED_MALFORMED`、`EXPIRY_MISSING`、
  `EXPIRY_MALFORMED`、`ADMISSION_BASIS_UNKNOWN`、`EVIDENCE_BLOCKER_MISSING`、
  `REVIEW_BY_MILESTONE`、`UNASSIGNED_COUNT`、`DUPLICATE_KEY` 等（`DUPLICATE_KEY` 由原文键
  扫描给出，pointer 为 `/`）。
- 登记表缺失/不可读 → `REGISTER_UNREADABLE` 直接转红，**不静默跳过**。
- 诊断只含静态字面量、计数与**已通过形状校验**的 id，绝不回显登记表里的自由文本。

闸门脚本：[scripts/check-deferral-register.mjs](../../scripts/check-deferral-register.mjs)；
测试：[scripts/tests/deferral-register.test.mjs](../../scripts/tests/deferral-register.test.mjs)。
