export function isLedgerTimeZone(value: string) {
  if (value !== "UTC" && !/^[A-Z][A-Za-z_]*\/[A-Za-z0-9_\-+/]+$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}

/** Business dates remain date strings; never re-interpret a stored date as a UTC timestamp. */
export function ledgerToday(timeZone: string, instant: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function ledgerTimestamp(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(value));
}
