import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requirePublicSupabaseConfig } from "./config";

export async function createClient() {
  const cookieStore = await cookies();
  const { url, key } = requirePublicSupabaseConfig();
  return createServerClient(
    url, key,
    { cookies: { getAll() { return cookieStore.getAll(); }, setAll(values) {
      try { values.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); }
      catch { /* Server Components cannot write cookies; Proxy carries their refreshed session. */ }
    } } },
  );
}
