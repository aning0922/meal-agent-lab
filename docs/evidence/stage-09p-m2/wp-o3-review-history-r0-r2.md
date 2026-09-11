# Stage 09P-M2 / WP-O3 评审谱系 r0–r2（历史审计事实）

本文件如实记录 WP-O3 决策包在取得 r3 `CLEAN` 之前的三轮独立评审。**历史 `BLOCK` 结论一律
原样保留，未被改写为 `CLEAN`**；它们与 r3 的 `CLEAN` 各自成立、互不抵消。所有轮次均为全新、
独立、只读评审，未运行 Docker、产品测试、DB、Node 或 gate。最终 `CLEAN` 记录见
[WP-O3 Fresh Review（r3）](wp-o3-fresh-review.md)。

## 轮次总览

| 轮次 | 候选身份 | L1 fail-closed | L2 authority | L3 adversarial | 结果 |
| --- | --- | --- | --- | --- | --- |
| r0 | pack 588 行 / 47,918 bytes / `9291a676…f86278` | **BLOCK** P0/P1/P2=`0/1/2` | CLEAN `0/0/1` | **BLOCK** `0/1/4` | BLOCK |
| r1 | pack 691 行 / 64,430 bytes / `5376c2a9…1db4c36` | **BLOCK** `0/1/3` | CLEAN `0/0/2` | CLEAN `0/0/2` | BLOCK |
| r2 | pack 732 行 / 71,761 bytes / `650a3998…d92fc` | CLEAN `0/0/1` | CLEAN `0/0/1` | CLEAN `0/0/3` | CLEAN（未达 0/0/0） |
| r3 | pack 793 行 / 83,548 bytes / `6e2775f4…5d754` | CLEAN `0/0/0` | CLEAN `0/0/0` | CLEAN `0/0/0` | **CLEAN** |

## r0 — BLOCK（两个 lens 各出 1 个 P1）

- **R0-F1（P1，L1）**：候选对 Q06 的核心问题（「本次事务已 rollback、旧 attempt 状态未知」是否允许
  same-identity 重试/重新执行）给出**两个互斥答案**：§3.1、§4.2 第 4 列、§8 矩阵说「允许」；
  §6.2 说「只允许查询/只读恢复，不允许重新执行写」。宽松一侧（E04 单独即可重试）在 R7-B/R7-C
  已接受材料中无据，且正落在「旧 attempt 可能仍在 commit capability 内」这一未证明情形上。
  实现者若采用宽松读法即形成 fail-open 的 same-identity 重执行路径。
- **F-01（P1，L3）**：与 R0-F1 同源，从对抗视角独立复现（攻击面 (c) 成立）。
- **R0-F2 / O3-AUTH-01 / F-02（P2）**：候选把 `R7-C R1-INV-CROSSATTEMPT-UNKNOWN`、
  `R7-C R1-INV-CANCEL-LADDER` 作为上游**正式不变量 id** 引用，但整条分支
  `git grep R1-INV` 零命中 —— id 系凭空构造，使上游 provenance 不可核验（所引语义本身为真）。
- **R0-F3（P2）**：候选绝对断言「代码中根本没有 command / attempt / generation / cancellation /
  receipt-entitlement / command-final no-effect 概念」，被分支源码推翻：客户端明确存在
  `CommandId`、`generation`、`authGeneration` 与 stale-attempt 概念（其 read-set 仅列
  `services/api`，未读 `apps/client`）。
- **F-03（P2）**：§8 联合状态矩阵的 N 行不完整，缺 `N | retention-unavailable` 与
  `N | inconclusive/unknown`，而 §13 却声称与 WP-O1 §6.3 的 4×7 矩阵方向一致。
- **F-04（P2）**：§6.2「客户端保持 U（或原 N）」弱于 WP-O1 的强制 N→U，为实施者保留了不建立
  U latch 的读法，正是 R0-F1 获得入场券的通路。
- **F-05（P2）**：Q09 的 non-reuse landmark 强制范围偏窄（仅限「曾 commit 或曾被 E03 终局」），
  排除 U/N 身份，与 §8 的 U|retention 行自相矛盾。

## r1 — BLOCK（L1 出 1 个新 P1）

- **F-1（P1，L1）**：Q09 候选答案把「该 identity 对应的命令**曾被接受**」列为 retention 后可公开
  知道的事实，并套用于同一文本明确纳入的 N/U/C/F 集合。对 N/U 而言，retention 只证明原结果的
  **可恢复能力失效**，不证明曾发生 commit —— 构成「缺失证据被当作 success」的路径（假成功披露），
  且与该段自称的「有限且否定性」直接冲突。
- **F-2 / R1-P2-1（P2，L1+L3 同报）**：§4.2 尾段把重执行写许可 (a) 定义为「无历史效果 +
  无在途/**未来** capability」，字面等于 P-a ∧ P-b ∧ P-c = E03，与 §3.1/§3.3/§6.2 的
  (a) = P-a ∧ P-b 冲突，并含「四处已对齐」的失实声明。
- **F-3（P2）**：§1 与 §12 把 R7-C 记为 `DESIGN_ONLY`，与已登记状态
  `R7-C_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED` 不符。
- **F-4（P2）**：§11 前言把承认的 oracle id 范围写成 `W01–W34`，而 §10 定义的是 `W19–W36`。
- **AUTH-P2-01 / R1-P2-2（P2，L2+L3 同报）**：§6.2/§7.2.1/§8 以 `WP-O1 §6.2(3)` 作为
  「能完整证明从未越过 handoff 才维持 N」的出处，而 §6.2(3) 恰是**相反**分支
  （重启/重绑/记录缺失 → 进入 U）；正确 authority 是 §6.2(1)。
- **AUTH-P2-02（P2）**：R7-C r1 §9「Cancellation ladder」step 4 的行号被记为 `line 166`，
  实际为 `line 167`（166 是 step 3）。

## r2 — CLEAN（三个 lens 均 CLEAN，但残余 5 个 P2，未达本仓 0/0/0 标准）

- **RA-P2-01（P2，L2）**：§4.2 联合区分表 E04 行把「同身份重新执行写」的许可指向「本表末两行的
  fence/F 条件」（含 P-c，其结论恰为禁止重做），与本包 (a) = P-a ∧ P-b 的唯一规范定义不一致。
- **R2-FC-01（P2，L1）**：§3.4/§7.2 把 retention 后公开事实的 wrapper 描述为「有限、否定性」，
  但同一列表的 `C` 条目是肯定披露（「曾被接受」），wrapper 与自身条目矛盾（措辞层面，无安全后果）。
- **R2-ADV-01（P2，L3）**：§6.2 默认列表与 §8 的 N→U 触发清单遗漏 E11（malformed/unrelated
  response），且 §8 未声明其为 WP-O1 §6.3 4×7 矩阵的投影及省略了哪些格。
- **R2-ADV-02（P2，L3）**：§3.4/§7.2 的「任何状态都不能被表达为未提交/无效果」字面覆盖 `F`，
  而 F 的逻辑含义恰为 E03 command-final no-effect。
- **R2-ADV-03（P2，L3）**：Q09 明含「不同版本/重新登录如何恢复」子问，而 non-reuse landmark 绑定
  exact identity key + namespace；`identityPolicyVersion` 属 identity key 成员，版本变更会移动
  namespace 使旧 landmark 不再覆盖，构成攻击面 (d) 的变体（当时仅声明不变量并推给 Q10）。

以上 r2 五项均在 r3 得到实质修订，并在 r3 由三个全新 lens 复核为关闭；r3 的修正方向一律沿
fail-closed 收紧或补齐，未放松任何既有 fail-closed 行为。
