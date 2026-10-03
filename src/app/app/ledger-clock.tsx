"use client";
import { createContext, useContext } from "react";
const TimeZone = createContext("UTC");
export function LedgerClockProvider({ timeZone, children }: { timeZone: string; children: React.ReactNode }) {
  return <TimeZone.Provider value={timeZone}>{children}</TimeZone.Provider>;
}
export const useLedgerTimeZone = () => useContext(TimeZone);
