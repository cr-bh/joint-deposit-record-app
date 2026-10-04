import type { NextResponse } from "next/server";

/** A redirect must carry refreshed/removed cookies from the session response. */
export function withSessionCookies(source: NextResponse, target: NextResponse) {
  source.cookies.getAll().forEach(cookie => target.cookies.set(cookie));
  target.headers.set("Cache-Control", "private, no-store");
  return target;
}
