import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const createSchema = z.object({ householdId: z.string().uuid(), name: z.string().trim().min(1).max(60) }).strict();
const archiveSchema = z.object({ id: z.string().uuid(), archived: z.boolean() }).strict();

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "事项内容无效" }, { status: 400 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { data, error } = await supabase.rpc("create_spending_project", { target_household: parsed.data.householdId, project_name: parsed.data.name });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data, name: parsed.data.name.trim() });
}

export async function PATCH(request: Request) {
  const parsed = archiveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "事项操作无效" }, { status: 400 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { error } = await supabase.rpc("set_spending_project_archived", { project_uuid: parsed.data.id, archived: parsed.data.archived });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
