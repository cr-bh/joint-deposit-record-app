import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { householdIdSchema, invitationCreateSchema } from "@/lib/validation/invitation";
import { invitationErrorMessage } from "@/lib/invitations/errors";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsedId = householdIdSchema.safeParse(id);
  const parsedBody = invitationCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsedId.success || !parsedBody.success) return NextResponse.json({ error: "邀请请求无效" }, { status: 400 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { data, error } = await supabase.rpc(parsedBody.data.replaceExisting ? "replace_invitation" : "create_invitation", { target_household: parsedId.data, invited_email_input: parsedBody.data.email });
  const headers = { "Cache-Control": "private, no-store" };
  if (error) {
    const existing = error.message === "an active invitation already exists for this email";
    return NextResponse.json({ error: invitationErrorMessage(error.message), ...(existing ? { code: "active_invitation_exists" } : {}) }, { status: existing ? 409 : 400, headers });
  }
  return NextResponse.json({ token: data }, { headers });
}
