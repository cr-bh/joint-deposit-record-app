export function safeNextPath(value: string | null | undefined, fallback = "/") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  const parsed = new URL(value, "http://local.gongzhu");
  if (parsed.origin !== "http://local.gongzhu") return fallback;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Keep local browser cookies on their original host when Next binds to all interfaces. */
export function authRedirectOrigin(request: { url: string; headers: Headers }) {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (process.env.NODE_ENV === "development" && url.hostname === "0.0.0.0" && host && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) {
    return `${url.protocol}//${host}`;
  }
  return url.origin;
}
