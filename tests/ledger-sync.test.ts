import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ledgerSyncController } from "@/lib/supabase/ledger-sync";
describe("ledger recovery from missed Realtime events", () => {
  beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
  it("reconciles initial subscription, bursts and reconnection with one snapshot per burst", () => {
    const refresh = vi.fn(), state = vi.fn(), sync = ledgerSyncController(refresh, state);
    sync.status("SUBSCRIBED"); sync.changed(); sync.changed(); vi.advanceTimersByTime(180);
    expect(refresh).toHaveBeenCalledTimes(1);
    sync.status("CHANNEL_ERROR"); expect(state).toHaveBeenLastCalledWith("reconnecting");
    sync.status("SUBSCRIBED"); vi.advanceTimersByTime(180); expect(refresh).toHaveBeenCalledTimes(2);
  });
  it("does not refresh offline; online and foreground catch up without relying on an event", () => {
    const refresh = vi.fn(), state = vi.fn(), sync = ledgerSyncController(refresh, state);
    sync.changed(); sync.connectivity(false); vi.advanceTimersByTime(1000);
    expect(refresh).not.toHaveBeenCalled(); expect(state).toHaveBeenLastCalledWith("offline");
    sync.connectivity(true); sync.foreground(); vi.advanceTimersByTime(180); expect(refresh).toHaveBeenCalledTimes(1);
    sync.reconcile(); vi.advanceTimersByTime(180); expect(refresh).toHaveBeenCalledTimes(2);
  });
  it("disposal cancels queued work and late socket callbacks", () => {
    const refresh = vi.fn(), state = vi.fn(), sync = ledgerSyncController(refresh, state);
    sync.changed(); sync.dispose(); sync.status("SUBSCRIBED"); sync.connectivity(true); sync.foreground(); vi.runAllTimers();
    expect(refresh).not.toHaveBeenCalled(); expect(state).not.toHaveBeenCalled();
  });
});
