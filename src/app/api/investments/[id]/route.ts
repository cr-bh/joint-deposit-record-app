import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { investmentMetadataSchema } from '@/lib/validation/investment';
export async function PATCH(request: Request, {params}: {params: Promise<{id:string}>}) {
 const {id} = await params, parsed = investmentMetadataSchema.safeParse(await request.json().catch(() => null));
 if (!z.string().uuid().safeParse(id).success || !parsed.success) return NextResponse.json({error:'标的信息无效'},{status:400});
 const supabase = await createClient(), {data:{user}} = await supabase.auth.getUser();
 if (!user) return NextResponse.json({error:'未登录'},{status:401});
 const i=parsed.data,{error}=await supabase.rpc('update_investment_metadata',{target_investment:id,investment_name:i.name,ticker_input:i.ticker??'',asset_type_input:i.assetType,unit_name_input:i.unitName,note_input:i.note,cadence_input:i.valuationCadence});
 return error ? NextResponse.json({error:error.message},{status:400}) : NextResponse.json({ok:true});
}
