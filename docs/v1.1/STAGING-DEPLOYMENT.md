# HTTPS 测试站部署与跨设备第一批验收

更新：2026-10-03 America/New_York。状态：用户已选择部署独立HTTPS测试站；配置准备完成；用户补充原项目曾有联网站点，原公开仓库API的homepage已确认 https://joint-deposit-record-app.vercel.app，平台Vercel；尚待用户确认这是原站点并明确部署项目访问权限，再决定复用托管账号还是新增Vercel项目。尚未部署，没有可交付公网URL。

## 候选部署对象（Vercel，项目访问权限待确认）

- 用户仓库 `cr-bh/joint-deposit-record-app`，分支 `codex/gongzhu-v1.1-p1`；不从旧main分支部署。
- 独立Vercel项目候选名称 `gongzhu-staging`，个人免费方案；Node.js 22，Next.js，仓库根目录。`vercel.json`固定 `npm ci` 与已验证的webpack构建。
- 继续连接现有隔离Supabase `gongzhu-staging` / `yzpkdhlkhhlhgmnsdkgd`。已有真实测试账号和用户创建的空账本继续使用；不重建或重跑数据库安装。
- Vercel运行环境中配置 `.env.example` 中的 `NEXT_PUBLIC_SUPABASE_URL` 和 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`。值来自被忽略的本地配置；只传公开客户端连接配置，不传数据库密码、Gmail应用密码或service_role。环境配置必须在构建前生效。
- 此项目的稳定HTTPS域名作为测试入口。它仍是隔离验收环境，即使Vercel将稳定域名所属环境命名为Production，也不代表v1.1正式发布。

## 外部账号当前阻塞

已核对原公开仓库homepage为 `https://joint-deposit-record-app.vercel.app`，用户确认托管平台为Vercel；本次浏览器访问返回504 / MIDDLEWARE_INVOCATION_TIMEOUT。未读取原部署日志、修改原站点或确认其数据库，不据此猜测故障来源。等待用户或伴侣在已打开的Vercel页面登录可用账号，然后新增连接当前隔离测试库的测试项目。

Vercel页面未登录；自动审批拒绝点击Continue with GitHub，理由是第三方OAuth可能申请账号/仓库访问且具体范围尚未确认。没有绕过或安装其他连接器。由用户亲自完成Vercel登录；首次使用时由用户确认条款。若安装GitHub应用，仅授权此用户仓库，具体页面权限需人工审阅。

## 部署后接通与核对

1. 使用当前开发分支创建部署，检查成功构建的提交与环境连接配置。设置此独立测试项目的部署分支，避免推旧main替换测试版本。
2. 取得实际稳定HTTPS域名后，在测试Supabase将Site URL设为该域名、追加其 `/auth/callback**`；保留已有本地回调。不要使用尚未分配的域名或所有站点通配。
3. 未登录访问应回登录；受保护API应返回JSON401；连接检查应就绪。公开页面不返回账本内容。
4. 成员A用已有共筑账号从HTTPS站登录，核对同一账本、时区、1/2成员及空资产。无需重建或重新注册A。
5. 从HTTPS站生成邀请。成员B在自己的设备打开，通过自己的邮箱注册、在同一浏览器确认邮件并返回邀请加入。第一批检查同账本2/2、独立会话和退出重登；完成后停下人工交付，不直接进入第二批资金流程。
6. 已生成邀请保存在数据库，部署本身不使它失效；只有URL来源需换成实际HTTPS域名。不要在公开文档、截图或日志记录完整邀请token。

## 本地地址限制与界面修复

`0.0.0.0` 是监听全部接口的绑定地址；localhost/127.0.0.1是设备自身回环。它们不能供其他设备直接使用。Supabase在云端不等于网页已部署。邀请窗口在这些地址显示本机范围提示；剪贴板不可用时自动选中链接供手动复制，不将其显示为邀请创建失败。

参考：[Vercel项目](https://vercel.com/docs/projects)、[环境变量](https://vercel.com/docs/environment-variables)、[Supabase回调](https://supabase.com/docs/guides/auth/redirect-urls)、[浏览器剪贴板限制](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)。
