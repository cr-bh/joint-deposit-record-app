import { NextResponse } from "next/server";
import { householdOnboardingSchema, householdTimeZoneSchema } from "@/lib/validation/household";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const parsed = householdOnboardingSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "账本名称、币种或时区无效" }, { status: 400 });
  const input = parsed.data;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { data, error } = await supabase.rpc("create_household", { household_name: input.name, reporting_currency_input: input.reportingCurrency, time_zone_input: input.timeZone, request_key: input.idempotencyKey });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data });
}

export async function PATCH(request: Request) {
  const parsed = householdTimeZoneSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "账本或时区无效" }, { status: 400 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { error } = await supabase.rpc("set_household_time_zone", { target_household: parsed.data.householdId, time_zone_input: parsed.data.timeZone });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
