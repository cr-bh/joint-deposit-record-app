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
    const checks = [
      "households?select=id,time_zone,time_zone_confirmed,ledger_version,archive_snapshot_id&limit=0",
      "profiles?select=id,display_name&limit=0", "household_members?select=household_id,user_id,role,active&limit=0",
      "invitations?select=id,revoked_at&limit=0", "household_archives?select=id,proposal_id&limit=0",
      "proposals?select=id,payload,idempotency_key,fx_snapshot_id&limit=0",
      "ledger_entries?select=id,account_kind,quantity_micro,effective_sequence,refund_source_entry_id,recovery_original_minor,void_proposal_id&limit=0",
      "cash_accounts?select=household_id,kind&limit=0", "cash_transfers?select=id,movement_type,destination_amount_minor,destination_currency&limit=0",
      "investments?select=id,opening_quantity_milli,opening_cost_minor,position_version&limit=0",
      "investment_valuations?select=id,input_mode,quantity_micro,total_value_minor,basis_signature&limit=0",
      "fx_rate_snapshots_exact?select=id,usd_to_cny,usd_to_hkd,source_note&limit=0",
      "reimbursement_claims?select=id,source_entry_id,claimed_minor,version,refunded_member_minor,returned_minor&limit=0",
      "settlement_batches?select=id,proposal_id,ledger_entry_id,amount_minor&limit=0",
      "settlement_allocations?select=id,batch_id,claim_id,amount_minor,payment_minor,status&limit=0",
      "void_requests?select=id,proposal_id&limit=0", "spending_categories?select=id,name,archived_at&limit=0", "spending_projects?select=id,name,archived_at&limit=0",
    ];
    const responses = await Promise.all(checks.map(path=>request(`${config.url}/rest/v1/${path}`,{headers,cache:"no-store",signal:AbortSignal.timeout(8000)})));
    result.database = responses.every(r=>r.ok) ? "ok" : "error";
    result.message = result.database === "ok" ? "登录服务和账本业务表结构可用；仍需完成实际注册、邀请、权限与双人业务验收。" : "登录服务已连接，账本表结构检查未通过；请核对迁移及 Data API 访问配置。";
    return result;
  } catch {return {...result,auth:result.auth === "ok" ? "ok" : "error",database:result.auth === "ok" ? "error" : "unchecked",message:"连接超时或网络不可用，请稍后重试。"};}
}
