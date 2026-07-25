# 阶段 08：家庭成员与硬约束纵切实施记录

- 原始实施日期：2026-07-24
- 审计整改日期：2026-07-25
- 状态：**Implemented；最终验收由[审计整改记录](2026-07-stage-08-audit-closeout.md)取代**
- 当前 contracts：`0.4.0`

## 原始目标

阶段 08 建立“邀请加入家庭 → 成员与 linked/dining-only PersonProfile → 饮食硬/软约束 → 字段级 redaction”的服务端和客户端纵切，覆盖 [FAM-003、FAM-004 与 FAM-005](../product/app-functional-spec.md) 的当前冻结范围。菜单推荐、菜谱、采购、完整做饭和 Agent 不在本阶段。

原始纵切在 `0001_stage_08.sql` 中新增邀请资源和相关 RLS，并交付邀请、加入、成员、档案和约束页面。后续审计发现敏感幂等缓存、membership 权限、profile 生命周期、OpenAPI 一致性、客户端范围和测试真实性不足，因此原始“完成”结论不再单独构成验收。

## 审计后边界

最终阶段 08 在不修改既有 migration 或 checksum 的前提下依次增加单事务 `0002_stage_08_audit_closeout.sql`、`0003_stage_08_secondary_closeout.sql` 与 `0004_stage_08_final_closeout.sql`，契约保持 `0.4.0`。详细架构理由见 [ADR-0004](../architecture/decisions/0004-stage-08-pre-release-audit-closeout.md)。

### FAM-003

阶段 08 冻结范围已完成：

- 登录成员与 dining-only profile 的统一 list/get；
- displayName、默认饭量、默认参与和厨艺的 unknown/null、查看和编辑；
- active/archived 过滤以及同 ID archive/restore；
- 成员退出/移除时原子归档 linked profile；
- dining-only 关联登录成员的 owner 发起 + 被关联用户确认。

关联请求只能由 owner 通过受控数据库函数创建，披露快照在统一 household 锁内计算；确认前会重新验证 target active。请求固化发起时的 profile version 和安全披露，名称或约束发生变化会提交 `profile_changed` 终态，客户端重新读取、展示并确认。历史请求没有快照证据时只标记 `legacy_unavailable`。不按姓名自动合并，不在重新加入时自动恢复或复制私人约束。转回 dining-only 需要未来独立确认命令，不属于 FAM-003 当前已定义的用户行为。

### FAM-004

已完成：

- allergy、religious、ethical、explicit avoid、food safety exclusion 与 soft preference；
- allergen/food concept 标识符输入；
- hard constraint 二次确认，指纹覆盖包括 visibility 在内的全部字段；
- owner/self 完整视图与 household 安全投影；
- 当前无权威映射词表，形状校验不能标为 structured；全部 hard constraint 标记 `needs_structured_mapping`，推荐必须阻断。

阶段 08 不发明 allergen、food concept、宗教、伦理或食品安全正式规则词表；在权威映射和推荐安全闭环完成前不得声称 FAM-004 全部完成。

### FAM-005

部分完成：

- cooking skill 支持 unknown/null、查看和编辑；
- 新建不猜测技能值。

尚未建立正式 cooking-technique 词表，也没有“不会或不愿执行的技术”机器可执行集合。该词表是阶段 09 数据治理前置项；在完成前不得声称 FAM-005 全部完成。

## 最终本地验收

最终验收不再使用原始 `0.3.0`、8 条新增路由或旧测试数量。当前生成 OpenAPI 覆盖 19 paths / 25 method operations；本地门禁为：

| 层 | 结果 |
| --- | --- |
| contracts | 26/26 |
| API unit | 12/12 |
| API HTTP | 5/5 |
| PostgreSQL migration/RLS/concurrency | 43/43 |
| client unit + 页面渲染 | 102/102 |
| stage 07 + stage 08 E2E | 21/21 |
| audit gate 反向单测 | 7/7 |
| weapp build | Pass |
| GUI | `c68217ed` 页面视觉范围 Pass；0004 增量未伪造新 GUI Pass，见[证据](../evidence/stage-08-gui/README.md) |
| 依赖审计 | 原始 1 critical、1 high、8 moderate；local/weapp-only 限时例外门禁 Pass |

最终命令、数据兼容、风险和 Deferred 以[审计整改记录](2026-07-stage-08-audit-closeout.md)为准。本文件保留原阶段目标和边界，不再作为独立的“可开始阶段 09”依据。
