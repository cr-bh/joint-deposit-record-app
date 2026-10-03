import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { proposalIdSchema } from "@/lib/validation/decision";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = proposalIdSchema.safeParse((await params).id);
  if (!parsed.success) return NextResponse.json({ error: "提案编号无效" }, { status: 400 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { error } = await supabase.rpc("withdraw_proposal", { proposal_uuid: parsed.data });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ withdrawn: true });
}
