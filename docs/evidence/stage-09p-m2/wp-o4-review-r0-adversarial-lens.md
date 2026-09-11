CLEAN
P0=0 / P1=0 / P2=8

# Stage 09P-M2 / WP-O4（r1）全新独立 Fresh Design Review（r0）— 单 lens 对抗性反例猎捕

- 日期：2026-09-12（Asia/Shanghai）
- 评审轮次：r0（首个独立评审）；评审对象为 r1 精确候选（decision pack + 伴随 evidence）
- 结论：**CLEAN**；`P0=0 / P1=0`（无 BLOCK 级缺陷），`P2=8`（缺陷均为精确性/证据绑定/覆盖声明类，不构成
  对 Q05 语义答案的 fail-open）。**因 P2>0，本结论不等于 0/0/0，不等于 `Accepted` / `CONTRACT_FROZEN`。**
- 评审结构：**单一 lens** —— L3 对抗性反例猎捕（adversarial counterexample hunt）。本评审**不是**三 lens
  互盲评审，只提交一个 lens 的独立结论；另两个 lens 的结论不由本文件代表。
- 未执行：任何 Docker、产品测试、DB、Node、Taro、Fastify、migration 或 gate；未改写候选；未切换分支；
  唯一写入为本文件（`.local/wp-o4/` 下）。

## 1 候选与权威源身份（本次实测）

| 对象 | Lines | Bytes | SHA-256（本次计算） |
| --- | ---: | ---: | --- |
| `wp-o4-public-semantics-and-carrier-decision-pack.md` | 490 | 48,207 | `0f87591d63e42de7e760aeb2a16a1c32e6c05b8c4f4297b44abe4dd2843e7e59` |
| `wp-o4-public-semantics-and-carrier-evidence.md` | 304 | 25,307 | `1a4dfeb31cac6b3ff33e8092443bbcede35385772f53b8f9956cd7843ee98667` |

工作树：`main` @ `23450a1f3508e8030d753748291d265ad308df05`，`git status --porcelain=v1
--untracked-files=all` = ` M AGENTS.md`（唯一未提交改动；本评审未读取、未依赖）。材料权威 ref
`codex/stage-09p-m2-inventory` @ `41d47eb`；WP-O3 材料 worktree `codex/stage-09p-wp-o3` @ `17c579d`。
上游源（WP-O1 §5/§6.1/§6.2/§6.3/§9 O01–O16、WP-O2 §5.2/§6.2/§6.4/§6.5 与 W01–W18、WP-O3 §4–§9 与
RA-01–RA-27/W19–W37、R7-C r1 §8/§9/§11/§12、`api.ts`/`inventory-v2.ts`/`errors.ts`/`routes.ts`/
`api-client.ts`/`idempotency.ts`）以只读 `git show` 核验。

## 2 对抗性反例猎捕：六臂攻击与封死位置

方法：对 Q05 四问（(a) 尝试局部/命令终局/恢复暂不可用/结果不可恢复；(b) 域 result rejected 的获准
envelope；(c) problem↔receipt 关联；(d) 无 response 约束）逐臂构造 **N/U/C/F × 7 观察格**的具体场景，
问“client 严格按本包允许 wire 说的话行事，是否会得出错误结论”。**六臂攻击全部被封死，未找到存活反例。**

- **(a) commit 仍可能却得出 terminal no-effect**：攻击“cancel ack 单方建立 F”被 §3.1/§4.1 P-4
  （三谓词 P-a∧P-b∧P-c 齐备）+ WP-O3 RA-05 挡下；攻击“E04/E05 单独推出命令 no-effect 或开放同身份重执行写”
  被 P-2（不得称原命令失败/无效果；不得据此开放同身份重执行写）挡下；攻击“`N`/`U` × retention 被读成 F”
  被 P-7（state-relative：N/U 只讲“结果未知且恢复受阻”）+ §4.2 false-success 禁止 + W39 挡下。**封死。**
- **(b) 未确认命令被判 success**：攻击“2xx `data.kind=rejected` 走 generic success”被 P-8 挡下；攻击
  “裸 2xx（`accepted_chunk`/`finalized`）即 C”被 P-3（C 仅来自 E01/E02，且限原 chunk/operation）+
  §4.2 I-04“任何单一信号不自证范围”+ CB-9（HTTP status/media type 不得代替 evidence scope）挡下；
  攻击“`replayed=true`/`requestId` 充当结果真伪证据”被 P-3 不得列 + WP-O1 E02 挡下。**封死。**
- **(c) 迟到/不相关响应被用来结算本命令**：攻击“旧 generation 回调（E12）或跨 scope/wrong key/body/
  version 响应（E11）被消费”被 P-9（无业务内容披露、不据其内容结算）+ §4.2 + W43 挡下；攻击“迟到 2xx
  `rejected` 清既有 U latch 并结算命令 failure”被 P-8 不得列（不得因 `kind=rejected` 结算全命令 failure）
  + K-5 挡下。**封死。**
- **(d) problem 响应被当成证明了它并未证明的 receipt 关联**：攻击“仅凭 `requestId` 回显/HTTP status/相邻
  时间/“当前只有一个 pending”就把 problem 归因某命令”被 §6.2 O5-3c（显式列举上述均不得充当关联证明）+
  §6.3（delivery 维度不得顶替 command 维度）+ §3.3（无法证明关联一律按 E11）挡下；攻击“409 CONFLICT
  （legacy 已提交业务拒绝）被读成‘command 已 commit’”被 P-9（wrong key/body → E11，无 settlement）+
  P-2（不得据此开放重做）挡下。**封死。**
- **(e) 无 response/timeout/reset 被当成命令命运的证据**：攻击“timeout/socket close/abort 被当成
  definite-failure 或‘未发送’”被 §3.4 + K-1（默认 unknown）+ §7.1（不得用伪造错误枚举宣布确定失败）+
  K-7（本地超时 ≠ 服务端 deadline）+ K-8（`reply.finish` 不证明 client 收到）+ §7.3（不得用本地 network0
  填补同 identity 历史空白）+ W44/W45 挡下。**封死。**
- **(f) retention 后 `N`/`U` 被推成“曾被接受”**：攻击“retention/absence 推出曾被接受（false-success）”
  被 §3.1、§4.1 P-7、§4.2（false-success 禁止，本包最硬约束）、§11 PS-08、W39/W40 挡下；攻击“absence
  推出未提交/可重做”被 P-7 不得列 + PS-10 + W34 挡下。**封死。**

**未发现任何 GL-* 级（fail-open）路径**：本包在六臂上均取较弱/未确认一侧，且 K-5/K-6/K-9 与 CB-5/CB-10
把“清除 latch/由 absence 推断/跨重启失忆”三条最危险的旁路显式封死。故本 lens 不判 BLOCK。

## 3 P2 findings（P0=0 / P1=0；以下均不构成对 Q05 语义答案的 fail-open）

| id | severity | 摘要 | 落点 / 证据 |
| --- | --- | --- | --- |
| ADV-01 | P2 | §6.3 与 §11 PS-20 把“requestId/originalRequestId 二分”归给 **WP-O2 D10**，但 D10 实为“unknown 跨 attempt 单调；generic status/error/retryable/deadline 不清除”，**不含** requestId/originalRequestId 二分 | 包 §6.3、§11 PS-20；`wp-o2` §10 D10（本行正文） |
| ADV-02 | P2 | §5.2(3) 对 legacy `dispositionForOutcome` 的清单**既过宽又过窄**：把 `transportError/malformedResponse → unknown`（K-1/P-5 下的正确 fail-closed 映射）并入“自行制造终局”；同时**遗漏** `{kind:'failed', executionUnknown===false} → definite-failure` 与末尾 unknown-kind fallback `return 'definite-failure'` 两个真正制造终局的分支 | 包 §5.2(3)；`apps/client/src/core/idempotency.ts` L370–410（`failed` 分支与末行 fallback） |
| ADV-03 | P2 | CB-3 的解除证据绑定 `W41`，但 W41 只覆盖 CB-3 的后半“不做**类别→终局**映射”（且仅就 domain 类别 `rejected`），**未**测试前半“B internal category（R7B.*/TRANSACTION_ABORT/…）不得原样上 wire”；以 W41 单独解除 CB-3 会留下未测义务 | 包 §5.1 CB-3；包 §10 W41 |
| ADV-04 | P2 | §4.1 P-8（及 §7.2 K-5 的 latch 保留清单）未显式写入其自身引源要求的“**既有 unknown 保留**”：WP-O1 E16 明载“既有 unknown 不清除”，K-5 枚举为“400/401/403/404/409/413/415/429 或 parser/query/auth/admission 拒绝”，未点名 2xx 域 `rejected`（E16 的 domain 半） | 包 §4.1 P-8、§7.2 K-5；WP-O1 §5 E16 |
| ADV-05 | P2 | §4.1 自称是 WP-O1 §6.3 4×7（28 格）矩阵在公开语义层的“投影”，但**未声明省略了哪些格**（对比 WP-O3 §8 曾因同一问题被 r2 判 R2-ADV-01 P2 并在 r3 逐一列出省略格）。经本次逐格核对，缺口格由 §4.2 状态单调与 P-1/P-2 隐含覆盖，**未发现 fail-open 格** | 包 §4.1 引言、§4.2；WP-O3 §8 投影/省略段 |
| ADV-06 | P2 | §4.2“范围显式”与 §5.3 方向 A 把 **retention-unavailable**、**auth-suspended** 与 attempt-local / command-terminal / inconclusive 并列为“五类必须公开可分且互不冒充”的单一“证据范围”值；二者实为正交轴（retention-unavailable × {C,N/U,F}；auth-suspended × {N,U,C,F}），单值 scope 字段无法表达 P-7 的 state-relative 披露，会把 C 与 U 压成同一个 “retention-unavailable” 值 | 包 §4.2、§5.3 方向 A；包 §4.1 P-7、§3.1 |
| ADV-07 | P2 | §5.1 CB-10 与 §7.1 以“**R7-C §9 正文**”承载“允许无 HTTP response”，但该陈述在 R7-C r1 **§8**（§8 header 于 line 112；line 141「client abort 明确允许『无 HTTP response』」）与 **§12**（line 249）；§9 的 header 在 line 144（Deadline ownership and cancellation ladder），不含该陈述。§12 引用正确，§9 引用错位（对比 WP-O3 r2 AUTH-P2-02 属同类行号/章节精度 P2） | 包 §5.1 CB-10、§7.1；`codex/stage-09p-m2-inventory:docs/evidence/stage-09p-m2/r7c-shadow-design-r1.md` L112/L141/L144/L249 |
| ADV-08 | P2 | 伴随 evidence **未登记 pack 的字节身份**（bytes/lines/SHA-256）并显式拒绝登记；WP-O3 evidence 对 r0–r3 均登记了伴随 pack 的字节身份。故本 WP-O4 候选**没有来自自身 evidence 的字节锚定**；候选身份只能由本 fresh review（§1）单独登记 | 包 evidence §1（“伴随输出文件登记（范围受限）… 编写本记录时为空”）；WP-O3 evidence §1（r0/r1/r2/r3 字节身份登记） |

## 4 结论与上限

- L3 对抗性反例猎捕：六臂攻击（(a)–(f)，含 N/U/C/F × 7 格场景）**全部被封死，无 P0、无 P1**；P2=8，
  均为引用精度（ADV-01/07）、legacy 清单完备性（ADV-02）、证据绑定（ADV-03）、行文显式性（ADV-04）、
  投影省略声明（ADV-05）、轴正交性（ADV-06）、provenance 登记（ADV-08）类，**不改变 P-1…P-10、CB-1…CB-10、
  O5-3a…e、K-1…K-9 的 fail-closed 方向**。
- 本报告**不**声称：候选已实现、已冻结契约、已关闭任何 G-*、已取得实现准入，或 Q05 已被关闭。因 P2>0，
  本候选**未达**本房规 `P0/P1/P2 = 0/0/0` 的接受标准；建议维持 `DESIGN_ONLY / READY_FOR_FRESH_REVIEW`
  上限，并由总控决定是否要求补足 P2 后重审。是否接纳为 Q05 逻辑设计基线由项目总控独立裁定；另两个
  lens 的结论不由本文件代表。
