import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { safeNextPath, authRedirectOrigin } from "@/lib/auth/redirect";
import { getPublicSupabaseConfig } from "@/lib/supabase/config";
import { withSessionCookies } from "@/lib/auth/session-response";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const origin = authRedirectOrigin(request);
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico") return NextResponse.next();
  if (process.env.NODE_ENV === "development" && pathname === "/preview") return NextResponse.next();
  if (pathname === "/setup" || pathname === "/api/setup/check") return NextResponse.next();
  const publicPath = pathname === "/login" || pathname === "/register" || pathname.startsWith("/auth/");
  if (!getPublicSupabaseConfig().ready) {
    if (publicPath) return NextResponse.next();
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "登录服务尚未配置" }, { status: 503 });
    const setupUrl = new URL("/setup", origin);
    setupUrl.searchParams.set("next", safeNextPath(`${pathname}${request.nextUrl.search}`));
    return NextResponse.redirect(setupUrl);
  }
  const { response, user, unavailable } = await updateSession(request);
  if (unavailable && !publicPath) {
    if (pathname.startsWith("/api/")) return withSessionCookies(response, NextResponse.json({ error: "登录服务暂时不可用，请稍后重试" }, { status: 503 }));
    const setupUrl = new URL("/setup", origin);
    setupUrl.searchParams.set("next", safeNextPath(`${pathname}${request.nextUrl.search}`));
    return withSessionCookies(response, NextResponse.redirect(setupUrl));
  }
  if (!user && !publicPath) {
    if (pathname.startsWith("/api/")) return withSessionCookies(response, NextResponse.json({ error: "登录已过期，请重新登录" }, { status: 401 }));
    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set("next", safeNextPath(`${pathname}${request.nextUrl.search}`));
    return withSessionCookies(response, NextResponse.redirect(loginUrl));
  }
  if (user && (pathname === "/login" || pathname === "/register")) {
    return withSessionCookies(response, NextResponse.redirect(new URL(safeNextPath(request.nextUrl.searchParams.get("next")), origin)));
  }
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
