import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { invitationAcceptSchema } from "@/lib/validation/invitation";
import { invitationErrorMessage } from "@/lib/invitations/errors";

export async function POST(request: Request) {
  const parsed = invitationAcceptSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "邀请请求无效" }, { status: 400 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { data, error } = await supabase.rpc("accept_invitation", { raw_token: parsed.data.token });
  if (error) return NextResponse.json({ error: invitationErrorMessage(error.message) }, { status: 400 });
  return NextResponse.json({ householdId: data });
}
