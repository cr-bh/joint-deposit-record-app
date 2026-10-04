import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { requirePublicSupabaseConfig } from "@/lib/supabase/config";
import { safeNextPath } from "@/lib/auth/redirect";
import { withSessionCookies } from "@/lib/auth/session-response";

export async function GET(request: NextRequest) {
  const url = new URL(request.url), code = url.searchParams.get("code");
  const nextPath = safeNextPath(url.searchParams.get("next"));
  const response = NextResponse.redirect(new URL(nextPath, url.origin));
  response.headers.set("Cache-Control", "private, no-store");
  if (code) {
    try {
      const {url:serviceUrl,key}=requirePublicSupabaseConfig();
      const supabase = createServerClient(serviceUrl,key, { cookies: { getAll: () => request.cookies.getAll(), setAll: (cookies) => cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options)) } });
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return response;
    } catch { /* Network failures use the same recoverable verification screen. */ }
  }
  const loginUrl = new URL("/login", url.origin);
  loginUrl.searchParams.set("next", nextPath);
  loginUrl.searchParams.set("error", "verification_failed");
  return withSessionCookies(response, NextResponse.redirect(loginUrl));
}
