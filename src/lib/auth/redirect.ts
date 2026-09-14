export function safeNextPath(value: string | null | undefined, fallback = "/") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  const parsed = new URL(value, "http://local.gongzhu");
  if (parsed.origin !== "http://local.gongzhu") return fallback;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
