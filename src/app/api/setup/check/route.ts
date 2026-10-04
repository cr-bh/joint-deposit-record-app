import { NextResponse } from "next/server";
import { getPublicSupabaseConfig } from "@/lib/supabase/config";
import { checkSupabaseConnection } from "@/lib/supabase/connection-check";
export async function GET() {
  const result = await checkSupabaseConnection(getPublicSupabaseConfig());
  return NextResponse.json(result,{headers:{"Cache-Control":"private, no-store"}});
}
