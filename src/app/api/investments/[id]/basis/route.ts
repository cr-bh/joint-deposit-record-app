import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
export async function GET(request: Request, {params}: {params: Promise<{id:string}>}) {
 const {id}=await params,date=new URL(request.url).searchParams.get('date');
 if (!z.string().uuid().safeParse(id).success || !z.string().date().safeParse(date).success) return NextResponse.json({error:'日期或标的无效'},{status:400});
 const supabase=await createClient(),{data:{user}}=await supabase.auth.getUser();
 if (!user) return NextResponse.json({error:'未登录'},{status:401});
 const {data,error}=await supabase.rpc('get_investment_basis',{target_investment:id,value_date_input:date});
 return error ? NextResponse.json({error:error.message},{status:400}) : NextResponse.json(data,{headers:{'Cache-Control':'no-store'}});
}
