# P8 实现状态与交付边界

更新：2026-10-04。本次按用户确认使用 NewNiu 新账本，暂不搬迁旧历史；第一批通过后，第二、三批合并开发并交付最后一次人工验收。

| 原计划范围 | 实现/检查结果 |
|---|---|
| PR-15 归档与恢复 | 双人申请/批准、非零资产和债务冻结快照、只读限制、版本/过期检查、恢复审批及历史快照保留已实现；临时PG并发/故障、云端回滚探针通过。 |
| PR-16 历史差异报告 | 只读检查付款成员、原单/批次、现金账户、历史汇率来源、旧数量/单价精度、投资历史；不猜测付款人或FIFO核销。 |
| PR-16 计算预演 | 三币种期初拆分守恒；全历史/期初互斥；旧流水保留可回读；切换日前现金不双计；纯计算测试通过。 |
| PR-16 实际写入迁移 | **未实现，本次排除**。双人事实修订确认、期初落库、切换前更正及真实旧库升级尚需另外完成。不能称整个原PR-16完成。 |
| PR-17 自动验收 | 226应用测试、19迁移/62PG检查、类型/lint/构建通过；增加随机序列、10k分页核对、失败回滚重试及冷备恢复权限核对。 |
| PR-17 云端验收 | 隔离Supabase19迁移；实际RPC/RLS回滚业务探针通过；邮件/注册/邀请第一批用户确认通过。探针使用模拟身份声明。 |
| PR-17 双设备E2E | **待最后一次人工验收**：真实独立Auth资金闭环、断网恢复、手机交互和双方归档恢复。 |

因此当前为 **NewNiu 新账本发布候选**，原P8全范围尚有历史迁移排除项和最终人工验收。逐项AC01—80状态见 [FINAL-VERIFICATION-MATRIX.md](FINAL-VERIFICATION-MATRIX.md)。

交付：[FINAL-ACCEPTANCE.md](FINAL-ACCEPTANCE.md)；维护：[OPERATIONS-RUNBOOK.md](OPERATIONS-RUNBOOK.md)；当前线上记录：[CURRENT-STATUS.md](CURRENT-STATUS.md)。

保留之前只读预览视觉证据：[归档影响桌面](screenshots/p8-archive-review-desktop.png)、[归档只读总览](screenshots/p8-archived-overview-desktop.png)、[恢复审批移动布局](screenshots/p8-restore-approval-mobile.png)。这些是演示界面证据，不代替最终真实双人验收。
