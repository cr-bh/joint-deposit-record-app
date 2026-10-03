import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { investmentCreateSchema } from '@/lib/validation/investment';
export async function POST(request: Request) {
  const parsed = investmentCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? '标的信息无效' }, {status:400});
  const input = parsed.data, supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({error:'未登录'},{status:401});
  const {data,error} = await supabase.rpc('create_investment_direct',{target_household:input.householdId,investment_name:input.name,ticker_input:input.ticker??'',asset_type_input:input.assetType,investment_currency:input.currency,unit_name_input:input.unitName,note_input:input.note,cadence_input:input.valuationCadence});
  return error ? NextResponse.json({error:error.message},{status:400}) : NextResponse.json({id:data});
}
