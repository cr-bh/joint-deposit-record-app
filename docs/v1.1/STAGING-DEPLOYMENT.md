# HTTPS 测试站部署与跨设备第一批验收

更新：2026-10-04 America/New_York。状态：独立HTTPS测试站部署完成，连接与未登录访问检查通过；第一批等待人工双人加入/会话验收，不推进第二批。

## 当前部署

| 项目 | 配置 |
|---|---|
| 稳定登录入口 | https://joint-deposit-record-app-beta.vercel.app/login |
| Vercel账号/项目 | Ariel / ariel-b0c2 / joint-deposit-record-app |
| 用户仓库 | cr-bh/joint-deposit-record-app |
| Production分支追踪 | codex/gongzhu-v1.1-p1 |
| 本次验收部署 | 982710d020c81fea36268a547877dda45546964c；JBDnHkSQ8dBrZv1dNRfZw3K945Ug |
| 构建 | Ready；Next.js，仓库根目录，Node22.x；vercel.json固定npm ci及webpack构建 |
| 数据库 | 隔离gongzhu-staging / yzpkdhlkhhlhgmnsdkgd；复用现有测试账号与空账本 |

用户先在自己的Ariel项目部署了旧main / 8388535，且未设置环境变量。本次保留该项目与稳定域名，改分支、设置两项公开客户端Supabase变量并重新部署；没有删除项目。Vercel的Production名称只表示此独立项目的稳定域名环境，不代表v1.1正式发布。

环境变量为NEXT_PUBLIC_SUPABASE_URL、NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY，来源为忽略提交的本地配置；未上传数据库密码、Gmail应用密码或service_role。后续开发分支推送会自动更新此测试站。

## 认证配置与验证

Supabase Site URL：`https://joint-deposit-record-app-beta.vercel.app`。回调白名单：

- `https://joint-deposit-record-app-beta.vercel.app/auth/callback**`
- `http://127.0.0.1:3000/auth/callback**`
- `http://localhost:3000/auth/callback**`

实际线上浏览器登录页正常；浏览器与HTTP `/api/setup/check` 均返回Auth/基础表正常、邮箱确认开启。未登录 `/app` 返回307至 `/login?next=%2Fapp`；`/api/households` 返回JSON401。检查不发送邮件、不读取资金，不能替代真实双人登录与业务验收。证据：[HTTPS连接检查](screenshots/batch1-https-connection-ready.png)。

## 邀请换发修复

813eddd已上线，Vercel部署G1aRqc6mCpSy86NTH6GdLXLQweCo为Ready且稳定域名指向此版本。修复“已有有效邀请却无法获得线上链接”：第一次重复生成显示换发说明，用户显式点击“换发邀请链接（旧链接失效）”后，数据库原子撤销同邮箱pending邀请并生成新的七天令牌，界面以当前HTTPS域名组成分享链接。新RPC仅管理员可操作，失败保留旧邀请，其他邮箱不变。已在隔离Supabase追加第18份迁移20261003090000；没有代替用户换发。API/页面相关33项、类型/lint/生产构建及临时PG57组通过，真实换发/加入仍待人工。

## 第一批人工接续

1. A使用已有共筑账号从上述HTTPS入口登录，核对原NewNiu账本、报告币种、America/New_York时区、1/2成员及空资产；不要重新注册A或重建账本。
2. A从HTTPS站生成邀请，已有有效邀请时点击“换发邀请链接（旧链接失效）”，自行分享给B；应用不自动发送邀请邮件。邀请链接应以此HTTPS域名开头。
3. B在自己的设备用独立邮箱注册，并在注册时同一个浏览器确认邮件，返回邀请加入A账本；B不另建账本。
4. 双方核对2/2成员、账号名称、刷新/退出重登和会话互不影响。第一批通过后再开始第二批资金流程和Realtime。
5. 已生成的数据库邀请不因部署失效；本地URL需要换成实际HTTPS域名。不要在公开文档、截图或日志保存完整邀请token。

## 原站点与账号历史

原站点 `https://joint-deposit-record-app.vercel.app` 位于James个人Hobby账号，连接JamessssLi旧仓库main / 3890578；此前访问504 / MIDDLEWARE_INVOCATION_TIMEOUT，未核查日志、不猜故障来源。本次没有修改或删除原站点，也没有连接旧数据库。

此前代点Vercel GitHub OAuth被自动审批拒绝，具体仓库权限未确认；后由用户亲自登录自己的Ariel账号。现已完成此独立项目部署，登录阻塞解除。

## 本地地址限制与界面修复

`0.0.0.0` 是监听全部接口的绑定地址；localhost/127.0.0.1是设备自身回环。它们不能供其他设备直接使用。Supabase在云端不等于网页已部署。邀请窗口在这些地址显示本机范围提示；剪贴板不可用时自动选中链接供手动复制，不将其显示为邀请创建失败。

参考：[Vercel项目](https://vercel.com/docs/projects)、[环境变量](https://vercel.com/docs/environment-variables)、[Supabase回调](https://supabase.com/docs/guides/auth/redirect-urls)、[浏览器剪贴板限制](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)。
