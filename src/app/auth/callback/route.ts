import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { safeNextPath } from "@/lib/auth/redirect";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const nextPath = safeNextPath(url.searchParams.get("next"));
  if (code) {
    const response = NextResponse.redirect(new URL(nextPath, url.origin));
    const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { cookies: { getAll: () => request.cookies.getAll(), setAll: (cookies) => cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options)) } });
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const loginUrl = new URL("/login", url.origin);
      loginUrl.searchParams.set("next", nextPath);
      loginUrl.searchParams.set("error", "verification_failed");
      return NextResponse.redirect(loginUrl);
    }
    return response;
  }
  const loginUrl = new URL("/login", url.origin);
  loginUrl.searchParams.set("next", nextPath);
  return NextResponse.redirect(loginUrl);
}
