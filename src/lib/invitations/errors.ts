const invitationErrors: Record<string, string> = {
  "invitation is invalid or expired": "邀请无效、已过期或已被使用",
  "invitation email does not match signed-in account": "当前登录邮箱与邀请邮箱不一致",
  "household is archived": "共同账本已归档，不能再接受或创建邀请",
  "household already has two active members": "共同账本已有两位成员",
  "already a member": "你已经是该共同账本的成员",
  "an active invitation already exists for this email": "该邮箱已有一份有效邀请",
  "owner permission required": "只有账本管理员可以创建邀请",
  "invalid email": "邀请邮箱无效",
};

export function invitationErrorMessage(message: string) {
  return invitationErrors[message] ?? "邀请操作失败，请重试";
}
