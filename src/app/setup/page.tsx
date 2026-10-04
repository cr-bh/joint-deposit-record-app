import { Suspense } from "react";
import SetupCheck from "./setup-check";
import { getPublicSupabaseConfig } from "@/lib/supabase/config";
export const dynamic = "force-dynamic";
export default function SetupPage() {
  const config = getPublicSupabaseConfig();
  return <Suspense fallback={<p className="p-8">正在载入连接状态…</p>}><SetupCheck configured={config.ready} initialMessage={config.ready ? "连接信息已配置，请检查服务状态。" : config.reason}/></Suspense>;
}
