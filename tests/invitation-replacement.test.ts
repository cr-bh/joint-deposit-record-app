import { beforeEach, describe, expect, it, vi } from "vitest";
const { getUser, rpc } = vi.hoisted(() => ({ getUser: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser }, rpc }) }));
import { POST } from "@/app/api/households/[id]/invitations/route";
const id = "00000000-0000-4000-8000-000000000001";
const send = (body: unknown) => POST(new Request("https://example.test/api/households/invitations", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
describe("invitation replacement API", () => {
  beforeEach(() => { vi.clearAllMocks(); getUser.mockResolvedValue({ data: { user: { id } } }); });
  it("returns a stable conflict code so the UI can offer replacement without invalidating the old link", async () => {
    rpc.mockResolvedValue({ error: { message: "an active invitation already exists for this email" } });
    const result = await send({ email: "partner@example.test" });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "active_invitation_exists" });
    expect(rpc).toHaveBeenCalledWith("create_invitation", { target_household: id, invited_email_input: "partner@example.test" });
  });
  it("uses the replacement RPC only on an explicit request and prevents caching of its new token", async () => {
    rpc.mockResolvedValue({ data: "a".repeat(64), error: null });
    const result = await send({ email: " partner@example.test ", replaceExisting: true });
    expect(result.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("replace_invitation", { target_household: id, invited_email_input: "partner@example.test" });
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });
  it("rejects malformed replacement flags and signed-out requests before invoking SQL", async () => {
    expect((await send({ email: "partner@example.test", replaceExisting: "true" })).status).toBe(400);
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await send({ email: "partner@example.test", replaceExisting: true })).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});
