const messages: Record<string, string> = {
  invalid_credentials: "邮箱或密码不正确，请重新输入。",
  email_not_confirmed: "请先打开注册确认邮件，验证邮箱后再登录。",
  user_already_exists: "该邮箱已有账号，请直接登录。",
  weak_password: "密码强度不足，请使用至少 8 位密码。",
  over_email_send_rate_limit: "验证邮件发送过于频繁，请稍后重试。",
  over_request_rate_limit: "操作过于频繁，请稍后重试。",
  email_address_not_authorized: "测试环境尚未配置向此邮箱发送确认邮件的服务，请联系账本管理员。",
  unexpected_failure: "登录或邮件发送服务出现错误，请稍后重试；持续失败时请管理员检查邮件配置。",
  signup_disabled: "当前暂未开放注册，请联系账本管理员。",
  otp_expired: "验证链接无效或已过期，请重新发送确认邮件。",
};
export function authErrorMessage(error: unknown, fallback = "登录服务暂时不可用，请稍后重试。") {
  if (error && typeof error === "object") {
    const value = error as { code?: string; status?: number };
    if (value.code && messages[value.code]) return messages[value.code];
    if (value.status === 429) return "操作过于频繁，请稍后重试。";
  }
  return fallback;
}
