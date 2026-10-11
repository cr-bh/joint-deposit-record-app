import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { scopedLedgerHref, selectHouseholdId } from "@/lib/domain/household-navigation";
import { LedgerNavigationProvider, LedgerHouseholdField, LedgerLink } from "@/app/app/ledger-navigation";
import { LedgerSettings } from "@/app/app/app-client";

const options = [
  { id: "archived", name: "旧账本", status: "archived" },
  { id: "active", name: "新账本", status: "active" },
];

describe("household navigation after archive", () => {
  it("defaults to an active ledger and still allows explicit archived-ledger access", () => {
    expect(selectHouseholdId(options)).toBe("active");
    expect(selectHouseholdId(options, "archived")).toBe("archived");
    expect(selectHouseholdId(options, "foreign")).toBeUndefined();
    expect(selectHouseholdId(options.slice(0, 1))).toBe("archived");
    expect(selectHouseholdId([])).toBeUndefined();
  });

  it("preserves ledger identity, filters, page, record and approval anchors", () => {
    for (const path of ["/app", "/app?tab=ledger&ledgerPage=2&category=餐饮", "/app?tab=ledger&entry=record", "/app?tab=approvals#approval-123"]) {
      const result = new URL(scopedLedgerHref(path, "archived"), "https://example.test");
      const original = new URL(path, "https://example.test");
      expect(result.searchParams.get("household")).toBe("archived");
      original.searchParams.forEach((value, key) => expect(result.searchParams.get(key)).toBe(value));
      expect(result.hash).toBe(original.hash);
    }
    expect(scopedLedgerHref("/preview?tab=ledger", "archived")).toBe("/preview?tab=ledger");
    expect(scopedLedgerHref("/onboarding", "archived")).toBe("/onboarding");
    expect(scopedLedgerHref("https://example.test/app", "archived")).toBe("https://example.test/app");
    expect(scopedLedgerHref("/app?tab=ledger")).toBe("/app?tab=ledger");
  });

  it("scopes rendered links and GET forms without affecting the preview", () => {
    const children = createElement("form", null, createElement(LedgerHouseholdField), createElement(LedgerLink, { href: "/app?tab=ledger" }, "流水"));
    const scoped = renderToStaticMarkup(createElement(LedgerNavigationProvider, { householdId: "archived" }, children));
    expect(scoped).toContain('name="household" value="archived"');
    expect(scoped).toContain("household=archived");
    expect(renderToStaticMarkup(children)).not.toContain("household");
  });

  it("shows archived settings with disabled controls and an explanation", () => {
    const html = renderToStaticMarkup(createElement(LedgerSettings, {
      close: () => {}, refresh: () => {}, setMessage: () => {},
      household: { id: "archived", name: "旧账本", reportingCurrency: "USD", status: "archived", timeZone: "America/New_York" },
      categories: [{ id: "category", name: "餐饮", isSystem: false }], projects: [],
    }));
    expect(html).toContain("设置仅供查看");
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain("餐饮");
    expect(html).toContain("America/New_York");
  });
});
