import type { PublicSupabaseConfig } from "./config";
export type ConnectionCheck = { configured: boolean; auth: "ok" | "error" | "unchecked"; database: "ok" | "error" | "unchecked"; emailConfirmation: boolean | null; message: string };
/** Zero-row checks inspect required columns without fetching users or ledger records. */
export async function checkSupabaseConnection(config: PublicSupabaseConfig, request: typeof fetch = fetch): Promise<ConnectionCheck> {
  const result: ConnectionCheck = {configured:config.ready,auth:"unchecked",database:"unchecked",emailConfirmation:null,message:""};
  if(!config.ready) return {...result,message:config.reason};
  const headers = {apikey:config.key};
  try {
    const auth = await request(`${config.url}/auth/v1/settings`,{headers,cache:"no-store",signal:AbortSignal.timeout(8000)});
    if(!auth.ok) return {...result,auth:"error",message:"登录服务连接失败，请核对项目状态和公开连接密钥。"};
    const settings = await auth.json();result.auth="ok";
    result.emailConfirmation = typeof settings.mailer_autoconfirm === "boolean" ? !settings.mailer_autoconfirm : null;
    const checks = ["households?select=id,time_zone,time_zone_confirmed,ledger_version,archive_snapshot_id&limit=0","profiles?select=id,display_name&limit=0","household_members?select=household_id,user_id,role,active&limit=0","invitations?select=id,revoked_at&limit=0","household_archives?select=id,proposal_id&limit=0"];
    const responses = await Promise.all(checks.map(path=>request(`${config.url}/rest/v1/${path}`,{headers,cache:"no-store",signal:AbortSignal.timeout(8000)})));
    result.database = responses.every(r=>r.ok) ? "ok" : "error";
    result.message = result.database === "ok" ? "登录服务和账本基础表结构可用；仍需完成实际注册、邀请及权限验收。" : "登录服务已连接，账本表结构检查未通过；请核对迁移及 Data API 访问配置。";
    return result;
  } catch {return {...result,auth:result.auth === "ok" ? "ok" : "error",database:result.auth === "ok" ? "error" : "unchecked",message:"连接超时或网络不可用，请稍后重试。"};}
}
