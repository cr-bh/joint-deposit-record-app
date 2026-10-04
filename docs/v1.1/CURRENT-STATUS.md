# 当前实现与交付状态

更新：2026-10-04。分支：`codex/gongzhu-v1.1-p1`。第一批人工检测由用户确认通过；用户要求后续工作合并完成，最后一次人工验收。范围为现有 **NewNiu 新账本**，暂不搬迁旧版本数据。

## 当前结果

P1—P7资金记录、双人审批、账户/汇率/分类与事项、代付/报销、投资、退款/返还/作废、总览/趋势/桑基图已实现；P8双人归档/恢复及只读冻结快照已实现。注册、确认邮件、登录、邀请加入和独立会话已由用户第一批反馈通过。

本次补齐：审批请求处理中防重复点击；Realtime订阅账本状态与作废请求；断网提示、重连/前台恢复重新取权威快照，30秒前台核对避免漏事件；完整业务表/精度字段的只读连接检查；旧数据只读疑点报告与切换日计算预演；随机序列、10,000条PG全量分页核对；升级失败回滚/重试、临时PG冷备还原；AC01—80证据矩阵、最终人工清单和运维手册。

最终本地检查 **226/226 应用测试、19份迁移、62组真实PostgreSQL验收、类型、ESLint、webpack生产构建通过**。本地Node24，部署/CI配置Node22。10k规模检查约259秒，验证一致性，不表示线上性能SLA。

隔离Supabase `gongzhu-staging` 已增量安装第19份迁移20261004100000，账本状态进入Realtime publication，RLS保持开启。云端回滚型RPC/RLS探针已通过存入、消费、代付、部分/跨币报销、组合投资、估值、卖出、分红、退款/返还、作废、幂等、越权、双人归档/恢复，临时记录确认回滚。使用已有成员身份声明，不替代真实Auth的两浏览器端到端验收；NewNiu原有资金记录不变。

部署入口：[HTTPS 共筑](https://joint-deposit-record-app-beta.vercel.app/app)。代码与文档已推送，部署及CI结果见下方交付记录。原James生产项目与旧数据库未修改。

## 最后需要人工确认

按 [FINAL-ACCEPTANCE.md](FINAL-ACCEPTANCE.md) 由双方独立账号一次完成金额闭环、跨币退款、断网恢复、归档/恢复与手机操作。已有NewNiu余额作为基线，检查新增验收记录的变化，不将已有数据归零。真实两浏览器金额流程尚未代替用户执行，**AC-80待最终人工验收，不将原P8整期标为全部通过**。

原计划PR-16完整历史写入迁移尚未完成，按用户决定不在本次NewNiu范围：双人事实修订、银行/券商期初落库、互斥核算模式切换、切换日前补录更正工具。当前只读报告与纯计算预演不提供实际搬迁入口。真实旧库升级与云端备份恢复也未执行。

逐项证据见 [FINAL-VERIFICATION-MATRIX.md](FINAL-VERIFICATION-MATRIX.md)。未来搬迁旧数据需另行补齐上述写入流程和真实旧库验收。历史第一批故障/部署记录见 [BATCH-1-ACCEPTANCE.md](BATCH-1-ACCEPTANCE.md) 和 [STAGING-DEPLOYMENT.md](STAGING-DEPLOYMENT.md)，其中较早等待状态已由本记录更新。

## 最终线上交付记录

代码提交 **b695e35139dfb6bde206cc4368dfdd2a1671240e** 已推送用户仓库；[Node22 CI 37179893325](https://github.com/cr-bh/joint-deposit-record-app/actions/runs/37179893325) 全部成功（类型、226测试、19迁移/62PG验收、lint、生产构建）。[Vercel H7iAbVmicSdJXUCmnSUwRfP9n4Fh](https://vercel.com/ariel-b0c2/joint-deposit-record-app/H7iAbVmicSdJXUCmnSUwRfP9n4Fh) 为 Ready，Source为同一代码提交，稳定HTTPS域名已指向此版本。[部署证据](screenshots/final-deployment-ready.png)。后续文档记录提交仅补验收证据，应用代码相同。

新版 `/api/setup/check`：configured=true、auth=ok、database=ok、emailConfirmation=true；18组业务字段零行请求全部200。未登录 `/app` 307，`/api/households` 401。管理员已有真实会话只读打开NewNiu，成员2/2、版本23、原有4条记录保持一致；同步初始/恢复提示随后消失，浏览器无error日志；账本管理与只读疑点报告正常加载。没有通过人工账号写入验收资金。

最新代码390px**本地合成数据**预览检查：页面宽度390、正文375，无页面横向溢出；管理弹窗宽343、高760、内容1114，可内滚动；审批和投资独立入口可识别。[管理手机布局](screenshots/final-management-mobile.png)、[审批手机布局](screenshots/final-approvals-mobile.png)、[投资手机布局](screenshots/final-investments-mobile.png)。该布局证据不冒充真实手机Auth闭环。

现在交付NewNiu发布候选，等待用户与伴侣按最终清单一次验收；本范围无已知自动检查失败。原计划历史写入迁移排除项、AC-80真实双人闭环和实际手机交互仍按上述边界保留。
