export type PublicSupabaseConfig = { ready: true; url: string; key: string } | { ready: false; reason: string };

/** Only public client credentials belong in NEXT_PUBLIC variables. Never include their values in errors. */
export function validatePublicSupabaseConfig(urlInput?: string, keyInput?: string): PublicSupabaseConfig {
  const url = urlInput?.trim(), key = keyInput?.trim();
  if (!url || !key) return { ready: false, reason: "尚未配置登录服务" };
  try {
    const parsed = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if ((!local && parsed.protocol !== "https:") || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error();
  } catch { return { ready: false, reason: "登录服务地址配置无效" }; }
  if (key.startsWith("sb_publishable_") && key.length > 20) return { ready: true, url: url.replace(/\/$/, ""), key };
  try {
    const parts = key.split(".");
    if (parts.length !== 3 || !parts.every(Boolean)) throw new Error();
    const payload = JSON.parse(atob(parts[1].replace(/-/g,"+").replace(/_/g,"/")));
    if (payload.role !== "anon") throw new Error();
    return { ready: true, url: url.replace(/\/$/, ""), key };
  } catch { return { ready: false, reason: "请配置公开的 publishable 或 anon 连接密钥" }; }
}

export function getPublicSupabaseConfig() {
  return validatePublicSupabaseConfig(process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function requirePublicSupabaseConfig() {
  const config = getPublicSupabaseConfig();
  if (!config.ready) throw new Error(config.reason);
  return config;
}
