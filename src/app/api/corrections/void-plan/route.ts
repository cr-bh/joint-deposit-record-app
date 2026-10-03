import {NextResponse} from 'next/server';
import {z} from 'zod';
import {createClient} from '@/lib/supabase/server';
const schema=z.object({householdId:z.string().uuid(),kind:z.enum(['entry','transfer','valuation']),id:z.string().uuid()});
export async function GET(request:Request){const q=new URL(request.url).searchParams,p=schema.safeParse(Object.fromEntries(q));if(!p.success)return NextResponse.json({error:'作废对象无效'},{status:400});const s=await createClient(),{data:{user}}=await s.auth.getUser();if(!user)return NextResponse.json({error:'未登录'},{status:401});const {data,error}=await s.rpc('get_void_plan',{target_household:p.data.householdId,target_kind:p.data.kind,target_id:p.data.id});return error?NextResponse.json({error:error.message},{status:400}):NextResponse.json(data,{headers:{'Cache-Control':'no-store'}});}
