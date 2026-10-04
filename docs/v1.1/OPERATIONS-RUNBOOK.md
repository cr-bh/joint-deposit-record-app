# NewNiu 新账本版运行与恢复

更新：2026-10-04；分支 `codex/gongzhu-v1.1-p1`。适用独立 HTTPS 测试站与 `gongzhu-staging`，不适用直接切换 James 原生产站。

## 已部署配置

- Vercel：Ariel / `ariel-b0c2/joint-deposit-record-app`；稳定域名 `https://joint-deposit-record-app-beta.vercel.app`。
- Production 分支追踪为上述开发分支。这里 Production 是 Vercel 托管环境名称，应用仍使用隔离测试数据库。
- Node22.x、Next.js preset、根目录 `./`。仓库 `vercel.json` 使用 `npm ci` 和 `npm run build -- --webpack`；不使用过时 main。
- 仅配置 `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`。浏览器使用公开连接密钥与每位用户自己的会话，业务权限由 RLS/RPC控制。不得放 service_role、数据库密码或 SMTP 密码进公开变量或仓库。
- Supabase Site URL 对应稳定 HTTPS 域名；允许该站 `/auth/callback**`，保留 localhost/127.0.0.1 本地回调。SMTP/邮箱确认由用户配置并在第一批通过。

推送开发分支后，确认 Vercel 新部署 Ready、Source SHA正确、稳定域名指向该部署，再验证 `/api/setup/check`、未登录 `/app` 回跳和 API401。页面能打开不代表数据库迁移、邮件或双人资金闭环全部通过。

## 数据库安装/增量

仓库现有19份迁移。全新空测试项目可用 `node scripts/prepare-empty-project.mjs /absolute/path/empty-project.sql` 生成一个事务内的安装包；它拒绝已存在业务表或迁移历史的数据库，不产生演示用户/资金。

已有 staging 只按版本顺序应用缺少的增量，不运行空库安装包，不修改已执行的旧文件。最新 `20261004100000_realtime_household_state.sql` 将 households 加入 publication，不增加读取权限、不改变金额；安装时应记录 `supabase_migrations.schema_migrations`。重复发布注册本身安全，但迁移历史版本只能记录一次。

核对：迁移历史19份；所有业务表RLS开启；Realtime包含proposals、entries、账户/划转、投资/估值、汇率、分类/事项、债权/核销、成员、households、archives及void_requests。客户端重新订阅、联网/前台返回时重读，并以30秒前台核对兜底。余额始终来自同版本完整数据库行，不从socket消息直接累加。

参考：[Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)。

## 备份与恢复

`npm run test:db` 在一次性本地PostgreSQL17.9中执行所有迁移、新空安装和已填充升级；注入失败并核对事务回滚，停库后复制完整临时数据目录，在另一端口恢复，逐表校验行数/指纹、迁移历史、函数定义、ACL和RLS，并复查成员/匿名/旧RPC权限。临时数据库与副本在测试结束清理。这证明本地测试恢复流程，不等于已有托管项目备份。

Free项目应另行安排逻辑备份；正式搬库前按 [Supabase备份指南](https://supabase.com/docs/guides/platform/backups) 使用官方CLI导出，并在**新的隔离项目**恢复验证。备份放在访问受限、不会提交Git的目录；数据库连接密码由项目所有者在本机配置，不发到聊天。SMTP、回调、公开连接配置和Realtime还需单独核对；不把只读账本快照当作完整Auth/平台备份。当前没有执行托管库恢复或旧库迁入。

## 失败处理

1. 构建失败：保持最后Ready部署，查看对应SHA的Vercel日志，修复后重新部署；不要删除整个项目。
2. 新界面回归：可回滚到此前已验收部署；此次新增同步publication不修改资金/表列，兼容前一客户端。不回滚数据库资金到过时状态来掩盖客户端问题。
3. 迁移SQL失败：先回滚事务并核对历史与实际结构。修复为新的增量，先在隔离副本预演；不重置 NewNiu、不盲目重复执行历史脚本。
4. 表结构检查异常：`/setup`和`/api/setup/check`检查18组业务表/视图字段，零行请求不取账本资料；缺表不能误报“配置成功”。
5. 邮件失败：查看Auth日志和SMTP配置，使用Google应用密码而非自行设置/日常登录密码；由所有者维护凭据，不能通过关闭邮箱确认绕过。
6. 邀请原链接丢失：管理员显式换发，旧链接失效。令牌只保存哈希，不能从数据库恢复明文；不要公开完整邀请链接。
7. 金额差异：记录账本版本、原单、批次和实际扣款/到账，先冻结操作并核对依赖；通过双人退款/返还/作废审批处理，不直接修改已入账行。

## 本地与验证命令

源码在仓库。为避免Cloud Documents按需下载导致不完整读取，本地运行副本为 `/private/tmp/gongzhu-p4-verify`，构建副本 `/private/tmp/gongzhu-batch1-build`。按字节完整读取源码并原子替换副本，排除 `.git`、node_modules、`.next*`、`.env*`及tsbuildinfo；不要用会把云端文件截空的同步方式。

验证依次为 `npm test -- --maxWorkers=1 --minWorkers=1`、`npm run test:db`、`npm run typecheck -- --pretty false --incremental false`、`npm run lint`、`npm run build -- --webpack`。CI在Node22同样执行。临时PG需要本地监听权限；默认端口55439，可用 `GONGZHU_TEST_PG_PORT` 避免冲突。

`scripts/staging-business-probe.sql` 仅用于指定的隔离项目：以两个已存在成员的身份声明调用真实RPC/RLS，执行PRD435、跨币报销/退款/返还、作废及归档恢复，最后整体ROLLBACK并确认没有探针账本残留。它不发送邮件、不创建认证用户、不触碰NewNiu记录；它也不等同于独立登录浏览器验收。
