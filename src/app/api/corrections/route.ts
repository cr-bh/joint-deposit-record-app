import {NextResponse} from 'next/server';
import {createClient} from '@/lib/supabase/server';
import {correctionRequestSchema} from '@/lib/validation/correction';
export async function POST(request:Request){const parsed=correctionRequestSchema.safeParse(await request.json().catch(()=>null));if(!parsed.success)return NextResponse.json({error:parsed.error.issues[0]?.message??'更正内容无效'},{status:400});const s=await createClient(),{data:{user}}=await s.auth.getUser();if(!user)return NextResponse.json({error:'未登录'},{status:401});const p=parsed.data,{data,error}=await s.rpc('submit_correction',{target_household:p.householdId,payload_input:p.payload,request_key:p.idempotencyKey});return error?NextResponse.json({error:error.message},{status:400}):NextResponse.json({id:data});}
