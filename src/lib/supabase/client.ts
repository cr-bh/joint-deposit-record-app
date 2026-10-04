import { createBrowserClient } from "@supabase/ssr";
import { requirePublicSupabaseConfig } from "./config";

export function createClient() {
  const { url, key } = requirePublicSupabaseConfig();
  return createBrowserClient(url, key);
}
