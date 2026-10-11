"use client";

import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import Link from "next/link";
import { scopedLedgerHref } from "@/lib/domain/household-navigation";

const HouseholdContext = createContext<string | undefined>(undefined);

export function LedgerNavigationProvider({ householdId, children }: { householdId: string; children?: ReactNode }) {
  return <HouseholdContext.Provider value={householdId}>{children}</HouseholdContext.Provider>;
}

// Forms replace the query string on submission, so they need an explicit field.
export function LedgerHouseholdField() {
  const householdId = useContext(HouseholdContext);
  return householdId ? <input type="hidden" name="household" value={householdId}/> : null;
}

export function LedgerLink({ href, ...props }: ComponentProps<typeof Link>) {
  const householdId = useContext(HouseholdContext);
  return <Link {...props} href={typeof href === "string" ? scopedLedgerHref(href, householdId) : href}/>;
}
