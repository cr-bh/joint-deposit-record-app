import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { safeNextPath } from "@/lib/auth/redirect";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (process.env.NODE_ENV === "development" && pathname === "/preview") return NextResponse.next();

  const { response, user } = await updateSession(request);
  const publicPath = pathname === "/login" || pathname === "/register" || pathname.startsWith("/auth/");
  if (!user && !publicPath) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", safeNextPath(`${pathname}${request.nextUrl.search}`));
    return NextResponse.redirect(loginUrl);
  }
  if (user && (pathname === "/login" || pathname === "/register")) {
    return NextResponse.redirect(new URL(safeNextPath(request.nextUrl.searchParams.get("next")), request.url));
  }
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
