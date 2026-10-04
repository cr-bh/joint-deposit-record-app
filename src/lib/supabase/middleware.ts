import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { requirePublicSupabaseConfig } from "./config";

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url, key } = requirePublicSupabaseConfig();
  const supabase = createServerClient(
    url, key,
    { cookies: { getAll: () => request.cookies.getAll(), setAll: (cookies) => { cookies.forEach(({ name, value }) => request.cookies.set(name, value)); response = NextResponse.next({ request }); cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options)); } } },
  );
  const { data: { user }, error } = await supabase.auth.getUser();
  response.headers.set("Cache-Control", "private, no-store");
  return { response, user, unavailable: Boolean(error && (error.status === 0 || (error.status ?? 0) >= 500 || error.name === "AuthRetryableFetchError")) };
}
