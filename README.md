# 共筑 · 双人共同资金账本

Next.js / React / TypeScript / Tailwind / Supabase。通过双人审批记录共同资金，不执行真实银行打款或券商交易。

v1.1 开发从 `main@3890578` 开始，分支 `codex/gongzhu-v1.1-p1`。范围和未完成项见 [开发记录](docs/v1.1/DEVELOPMENT.md)，三份 v1.1 规格快照在 [docs/v1.1](docs/v1.1/)。当前尚未达到 v1.1 发布条件。

## 本地运行

```sh
npm ci
cp .env.example .env.local
# 配置测试 Supabase 的 NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev -- --webpack
```

使用隔离测试 Supabase，按顺序应用 `supabase/migrations`，配置邮箱认证与回跳 URL，再注册两个独立用户测试协作。已有数据库仅应用尚未执行的增量迁移，不重置真实数据库。P1—P7 及流水体验补充的全部14份迁移已经在临时 PostgreSQL 17.9 执行，42 组数据库验收覆盖报销并发/RLS、P3→P4 历史打款升级、P4→P5 待审投资升级、投资组合回滚、历史超卖和估值依赖，以及原单退款、应返款/跨币返还、作废依赖重算和组合作废故障回滚，以及P7真实审批全流程资产435、负净消费和历史汇率核对；真实 Supabase Auth、邮件、Realtime 和双人浏览器全流程仍待验收。详见 [P7 状态核对](docs/v1.1/P7-STATUS.md) 和 [流水体验补充](docs/v1.1/LEDGER-UX-STATUS.md)。

没有数据库配置时可打开 `http://127.0.0.1:3000/preview?tab=overview` 查看只读合成数据效果，包括双账户、汇率、分类/事项、逐笔代付，以及部分/合并/跨币种报销、打款明细和核销进度，以及投资总市值估值、持仓涨跌幅、配置环图和银行转入买入组合表单，以及原单退款、成员应返款和返还、作废申请与估值历史，以及资产/往来/净额总览、消费趋势、消费与退款两张桑基图及点击追溯。该入口仅在开发环境开放，不会提交数据；权限与事务证据来自独立数据库测试。

## 检查

```sh
npm test
npm run test:db
npm run lint
npm run typecheck
npm run build
```

推送或提交 Pull Request 后，GitHub Actions 会在 Node.js 22 上自动执行类型、领域/组件测试、临时 PostgreSQL 数据库验收、代码规范和生产构建。

`test:db` 自动创建仅监听 `127.0.0.1:55439` 的一次性数据库，测试后关闭并删除；不会连接生产数据库。可用 `GONGZHU_TEST_PG_PORT` 改测试端口。使用 `embedded-postgres` 的平台二进制；若 npm 禁用了安装脚本，需要允许该平台包的 `hydrate-symlinks.js` 安装脚本。测试以最小 `auth.uid()` 会话声明模拟 Supabase 身份，SQL 角色、RLS、锁和事务在真实 PostgreSQL 执行；不替代 Auth 或 Realtime 验证。

组件测试使用静态 React 渲染验证提示和金额；不代替移动端视觉、双人端到端或数据库事务测试。测试汇率为合成算例，不是真实报价。

若当前沙箱禁止 Turbopack 编译时绑定本地端口，可使用 `NEXT_TELEMETRY_DISABLED=1 npm run build -- --webpack` 检查构建；这不修改默认构建配置。
