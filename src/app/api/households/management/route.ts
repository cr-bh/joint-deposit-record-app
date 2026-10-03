import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
const schema = z.object({ householdId: z.string().uuid(), action: z.enum(["archive","restore"]), reason: z.string().trim().min(1).max(500), expectedVersion: z.number().int().safe().nonnegative(), idempotencyKey: z.string().uuid() }).strict();
export async function GET(request: Request) {
  const id = z.string().uuid().safeParse(new URL(request.url).searchParams.get("householdId"));
  if (!id.success) return NextResponse.json({ error: "账本编号无效" }, { status: 400 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { data, error } = await supabase.rpc("get_household_management_plan",{ target_household: id.data });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "归档或恢复申请内容无效" }, { status: 400 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const input = parsed.data;
  const { data, error } = await supabase.rpc("submit_household_management",{ target_household: input.householdId, action_input: input.action, reason_input: input.reason, expected_version: input.expectedVersion, request_key: input.idempotencyKey });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data });
}
