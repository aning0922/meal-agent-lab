CLEAN
P0=0 / P1=0 / P2=2（fail-closed 0/0/0；authority 0/0/2；adversarial 0/0/0）

# Stage 09P-M2 / WP-O4 最终独立 Fresh Design Review（r5）

- 日期：2026-09-12（Asia/Shanghai）
- 评审轮次：r5（**最终轮**）；评审对象为 r5 精确候选
- 结论：**CLEAN**。三个 lens 的 P0=0、P1=0；fail-closed 与 adversarial 均为 `0/0/0`，
  authority 为 `0/0/2`，且**三个 lens 均明确回答该候选可作为 `DESIGN_ONLY` 设计基线采纳**
  （`adoptable_as_design_baseline = true`）。
- 评审结构：三个**互盲**独立 lens，各自只读；未运行 Docker、产品测试、DB、Node 或 gate；未改写候选。
- **本轮的 2 个残余 P2 不是设计主张缺陷**，而是文档自身记账的自描述不精确，见 §3。按本阶段
  预先声明的收敛规则，候选以**被评审的精确字节**采纳，不再为这 2 项改写（改写会使评审不再
  逐字节覆盖交付件）。该 2 项**如实登记、不隐藏**，属 fix-forward 项。

## 1 候选与权威源身份

| 对象 | Lines | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| WP-O4 public semantics / carrier 决策包 | 821 | 103,587 | `1bbca74b56b7aa5969c77357d5718fa7cef86a41b54b72313f87f7c0d7680f6e` |
| WP-O4 伴随 evidence | 336 | 28,641 | `9e3f19414d396feff32c3589fd3b53799098da4d721c09d4ba4862ccad5f592f` |

权威源基线（`codex/stage-09p-m2-inventory`）：tip `41d47ebfa02313e2f388ae1749b54f4cec3f97d8`，
tree `ec66e80cec1c89bb1ea6369df2ac7bcdf3d87ead`。WP-O3 材料取自工作树
`codex/stage-09p-wp-o3`。评审工作树为 `main` @ `23450a1f…`。

## 2 lens 结论

### 2.1 fail-closed completeness / invariant soundness — `0/0/0` CLEAN

逐项复核后未发现任何 fail-open 路径、无证明义务的公开陈述或 P0/P1。已核验：

- **requestId 口径已全节统一**：/§6.3/§3.3/§10 W42/§11 PS-20 与 §2.1/§5.2(2)/§6.2 O5-3c 现在一致，
  均只说「服务端回显请求侧 requestId；不能安全假设它标识『同一次投递』，至多为相关性提示」。
  代码核对属实：`app.ts` `genReqId` 对合法调用方 `x-request-id` 逐字采纳，否则
  `newEntityId()`；`routes.ts` `requestIdOf` 回显该值，故「回显为真、不承载唯一性」正确。
- **§4.1.1 自述与全部 28 格一致**，且**无任何禁令丢失**：逐格比对 WP-O1 §6.3「业务展示」列；
  被移出格的状态转移规则以不弱于原格的形式存续于 §4.1 P 行与 §4.2 状态单调
  （`N|auth` 的「无 dispatch 证明保留、否则 U」在 P-6；N→U 强制在 §4.2 与 PS-19；
  `F` 不被 attempt-local/较弱后续改写在 §4.2 单调 (i)）。
- **四类攻击面全部覆盖**：缺失/不可读结果（P-7 state-relative、W39/W40、PS-08…10）、无 response
  （§7 K-1…K-9、CB-10、PS-06、W44/W45）、调用方相关性 id（§6.1–§6.3、O5-3a…e、PS-11/PS-20、
  W42/W43）、2xx/4xx/5xx（§5.2(3)(a)–(d) 四条 legacy「自行制造终局」分支，行号与 `idempotency.ts`
  L371/L378–383/L384–387/L389–392/L394–408/L409 逐一对上；§8「至少四处」；CB-9；PS-04/PS-12；
  W38/W41）。未发现任何把 missing/unreadable、no-response 或 2xx/4xx/5xx 直达命令终局或成功披露的路径。
- 旁证：`api.ts` 全部行号归属正确；`commonErrorResponses` 仅 400/401/403/404/409/413/414/415/500/503，
  `PRECONDITION_FAILED`/`SAFETY_BLOCKED`/`RATE_LIMITED` 在 services 无构造点。

### 2.2 adversarial counterexample hunt — `0/0/0` CLEAN

对 (a)–(g) 七类攻击面 × N/U/C/F 逐一构造反例，**无一条存活**：命令终局 no-effect 而 commit 仍可能、
未确认命令被判 success（含只带 attempt-local 判定的 2xx）、迟到/无关响应被当作结算、用调用方指定的
相关性 id 伪造 receipt 关联、把无 response/超时/重置当作关于命令命运的证据、对 N/U 身份或在版本重绑后
推断「已被接受」、以及用本地导航/存储结果顶替命令结算——全部被包内明文条文关死。

### 2.3 authority and scope boundaries — `0/0/2` CLEAN（可采纳）

范围面**无越权**：未冻结任何 public DTO/字段名/状态码/reason/ordinal/route；无 B 侧内部类别进入公开
字段；无实现准入、未关闭任何 G-*；未重开 Q01/Q02/Q08 或 Q03/Q04/Q06/Q09；项目事实标签正确；
§2 读取清单经 r5 补齐后覆盖正文按行号引用的材料。残余 2 个 P2 见 §3。

## 3 登记在案的残余 P2（fix-forward，不阻断采纳）

| id | 内容 | 性质 |
| --- | --- | --- |
| AUTH-R5-01 | §17 的 r5 处置记录把相邻落点写成「§2.1 L128、§5.2(2) L341」，但该文件里这两个行号并不落在被归属的「投递」措辞上（实际在 §2.1 L130/L132、§5.2(2) L346–347） | 修订记录自身的行号不精确 |
| AUTH-R5-02 | §2 读取清单表头声明身份列为「Lines / Bytes / SHA-256」，但六个源码行只给出 SHA-256，缺 Lines/Bytes | 清单自描述不完整（所列 SHA 均实算且正确） |

两项**均不影响任何设计主张**：第一项是修订说明内的行号，第二项是读取清单的表头措辞。二者方向都不
产生 fail-open，也不改变本包的结论上限。后续若做 fix-forward，仅需修正这两处文本。

## 4 结论与上限

三个 lens 一致 `CLEAN`，P0=0 / P1=0，且一致判定**可作为 `DESIGN_ONLY` 设计基线采纳**。本报告
**不**声称：本候选已实现、已冻结契约、已关闭任何 G-* gate 或已取得实现准入。该候选至多是
`DESIGN_ONLY` 设计准备材料；是否接纳为逻辑决策基线由项目总控独立裁定。
