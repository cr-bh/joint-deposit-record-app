export type HouseholdOption = { id: string; name: string; status: string };

export function selectHouseholdId(options: HouseholdOption[], requested?: string) {
  if (requested !== undefined) return options.find(item => item.id === requested)?.id;
  return options.find(item => item.status === "active")?.id ?? options[0]?.id;
}

// Keep every drill-down and pagination link on the ledger being viewed.
export function scopedLedgerHref(href: string, householdId?: string) {
  if (!householdId || !/^\/app(?:[?#]|$)/.test(href)) return href;
  const url = new URL(href, "https://ledger.invalid");
  url.searchParams.set("household", householdId);
  return `${url.pathname}${url.search}${url.hash}`;
}
