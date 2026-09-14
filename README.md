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

使用隔离测试 Supabase，按顺序应用 `supabase/migrations`，配置邮箱认证与回跳 URL，再注册两个独立用户测试协作。已有数据库仅应用尚未执行的增量迁移，不重置真实数据库。当前新增的 P1 完整性迁移，以及 P2 双账户、汇率快照和共享用途分类/事项迁移尚未执行，新库/旧库集成验证仍待完成。

没有数据库配置时可打开 `http://127.0.0.1:3000/preview` 查看四个主页面的只读合成数据效果，包括双账户、手动汇率、实际换汇、共享分类/事项、账本设置和流水筛选。该入口仅在开发环境开放，不会提交数据，也不能据此确认登录、RPC、Realtime 和权限正确。

## 检查

```sh
npm test
npm run lint
npm run typecheck
npm run build
```

推送或提交 Pull Request 后，GitHub Actions 会在 Node.js 22 上自动执行同一组类型、测试、代码规范和生产构建检查。

组件测试使用静态 React 渲染验证提示和金额；不代替移动端视觉、双人端到端或数据库事务测试。测试汇率为合成算例，不是真实报价。

若当前沙箱禁止 Turbopack 编译时绑定本地端口，可使用 `NEXT_TELEMETRY_DISABLED=1 npm run build -- --webpack` 检查构建；这不修改默认构建配置。
