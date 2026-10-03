import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { settlementSchema } from "@/lib/validation/settlement";

export async function POST(request: Request) {
  const parsed = settlementSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "报销批次内容无效", issues: parsed.error.flatten() }, { status: 400 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { householdId, idempotencyKey, ...payload } = parsed.data;
  const { data, error } = await supabase.rpc("submit_settlement_batch", { target_household: householdId, payload_input: payload, request_key: idempotencyKey });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data });
}
