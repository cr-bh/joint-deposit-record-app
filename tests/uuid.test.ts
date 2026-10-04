import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createUUID } from "@/lib/uuid";

afterEach(() => vi.unstubAllGlobals());

describe("UUID compatibility", () => {
  it("uses the native generator with its Crypto receiver", () => {
    const crypto = { randomUUID() { expect(this).toBe(crypto); return "native-uuid"; } };
    vi.stubGlobal("crypto", crypto);
    expect(createUUID()).toBe("native-uuid");
  });

  it("generates valid v4 IDs with secure bytes when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => webcrypto.getRandomValues(bytes));
    vi.stubGlobal("crypto", { getRandomValues });
    const ids = Array.from({ length: 100 }, createUUID);
    ids.forEach(id => expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
    expect(new Set(ids).size).toBe(ids.length);
    expect(getRandomValues).toHaveBeenCalledTimes(ids.length);
  });
});
