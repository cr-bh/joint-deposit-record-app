import { afterEach, describe, expect, it, vi } from "vitest";
import { authRedirectOrigin, safeNextPath } from "@/lib/auth/redirect";
import { householdIdSchema, invitationAcceptSchema, invitationCreateSchema } from "@/lib/validation/invitation";
import { invitationErrorMessage } from "@/lib/invitations/errors";

afterEach(() => vi.unstubAllEnvs());

describe("本地认证跳转地址", () => {
  it.each(["127.0.0.1:3000", "localhost:3000", "[::1]:3000"])("保留浏览器原始回环地址 %s", host => {
    vi.stubEnv("NODE_ENV", "development");
    expect(authRedirectOrigin({url: "http://0.0.0.0:3000/login", headers: new Headers({host})})).toBe(`http://${host}`);
  });
  it.each(["evil.example", "127.0.0.1:3000@evil.example", "localhost.evil.example"])("拒绝非回环Host %s", host => {
    vi.stubEnv("NODE_ENV", "development");
    expect(authRedirectOrigin({url: "http://0.0.0.0:3000/login", headers: new Headers({host})})).toBe("http://0.0.0.0:3000");
  });
  it("生产环境使用请求原始来源", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(authRedirectOrigin({url: "https://gongzhu.example/login", headers: new Headers({host: "localhost:3000"})})).toBe("https://gongzhu.example");
  });
});

describe("认证回跳路径", () => {
  it("保留站内邀请路径和查询参数", () => {
    expect(safeNextPath("/invite/abc?source=email")).toBe("/invite/abc?source=email");
  });

  it.each([null, "", "https://example.com", "//example.com", "/\\example.com"])("拒绝站外或非法回跳 %s", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });
});

describe("邀请请求校验", () => {
  it("规范化邮箱并拒绝额外字段", () => {
    expect(invitationCreateSchema.parse({ email: "  partner@example.com " })).toEqual({ email: "partner@example.com" });
    expect(invitationCreateSchema.safeParse({ email: "partner@example.com", role: "owner" }).success).toBe(false);
  });

  it("只接受 UUID 账本和 64 位小写十六进制令牌", () => {
    expect(householdIdSchema.safeParse("00000000-0000-4000-8000-000000000010").success).toBe(true);
    expect(householdIdSchema.safeParse("household").success).toBe(false);
    expect(invitationAcceptSchema.safeParse({ token: "a".repeat(64) }).success).toBe(true);
    expect(invitationAcceptSchema.safeParse({ token: "A".repeat(64) }).success).toBe(false);
  });

  it("将数据库邀请状态转换为可操作的中文提示", () => {
    expect(invitationErrorMessage("invitation is invalid or expired")).toContain("已过期");
    expect(invitationErrorMessage("unexpected database detail")).toBe("邀请操作失败，请重试");
  });
});
