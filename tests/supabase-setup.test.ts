import { describe,expect,it,vi } from 'vitest';
import { NextResponse } from 'next/server';
import { validatePublicSupabaseConfig } from '@/lib/supabase/config';
import { checkSupabaseConnection } from '@/lib/supabase/connection-check';
import { withSessionCookies } from '@/lib/auth/session-response';
import { authErrorMessage } from '@/lib/auth/errors';
const url='https://example.supabase.co',key='sb_publishable_test_public_key';
const config=validatePublicSupabaseConfig(url,key);
const legacy=(role:string)=>`header.${Buffer.from(JSON.stringify({role})).toString('base64url')}.signature`;
describe('Public configuration guard',()=>{
 it('handles missing settings and accepts publishable/legacy anon with normalized local or HTTPS URLs',()=>{
  expect(validatePublicSupabaseConfig().ready).toBe(false);
  expect(validatePublicSupabaseConfig(`${url}/`,key)).toEqual({ready:true,url,key});
  expect(validatePublicSupabaseConfig('http://127.0.0.1:54321',legacy('anon')).ready).toBe(true);
 });
 it('rejects privileged keys without including their value in errors',()=>{
  for(const credential of ['sb_secret_should_not_leak',legacy('service_role'),'invalid']){
   const result=validatePublicSupabaseConfig(url,credential);expect(result.ready).toBe(false);expect(JSON.stringify(result)).not.toContain(credential);
  }
 });
 it('rejects credentials, remote HTTP, paths and query parameters',()=>{
  for(const invalid of ['http://example.supabase.co','https://user:password@example.com','https://example.com/rest','https://example.com/?key=x','file:///tmp/config'])expect(validatePublicSupabaseConfig(invalid,key).ready).toBe(false);
 });
});
describe('Connection check',()=>{
 it('does not make requests when configuration is absent',async()=>{
  const fetcher=vi.fn();expect((await checkSupabaseConnection({ready:false,reason:'missing'},fetcher)).configured).toBe(false);expect(fetcher).not.toHaveBeenCalled();
 });
 it('checks Auth and zero-row database columns without returning credentials or declaring user acceptance complete',async()=>{
  const requests:string[]=[];
  const fetcher=vi.fn(async(input:RequestInfo | URL)=>{requests.push(String(input));return Response.json(requests.length===1 ? {mailer_autoconfirm:false} : []);});
  const result=await checkSupabaseConnection(config,fetcher);
  expect(result).toMatchObject({auth:'ok',database:'ok',emailConfirmation:true});expect(result.message).toContain('仍需');
  expect(requests.slice(1)).toHaveLength(5);expect(requests.slice(1).every(url=>url.endsWith('limit=0'))).toBe(true);expect(JSON.stringify(result)).not.toContain(key);
 });
 it('separates a working Auth service from missing migrations',async()=>{
  let count=0;const fetcher=vi.fn(async()=>++count===1 ? Response.json({mailer_autoconfirm:true}) : new Response('{}',{status:404}));
  expect(await checkSupabaseConnection(config,fetcher)).toMatchObject({auth:'ok',database:'error',emailConfirmation:false});
 });
 it('fails safely for Auth errors and network failures',async()=>{
  expect(await checkSupabaseConnection(config,vi.fn(async()=>new Response('{}',{status:401})))).toMatchObject({auth:'error',database:'unchecked'});
  expect(await checkSupabaseConnection(config,vi.fn(async()=>{throw new Error(key);}))).toMatchObject({auth:'error',database:'unchecked'});
 });
});
describe('Session response and login errors',()=>{
 it('preserves refreshed and deleted cookie attributes across both redirect and JSON responses',()=>{
  const source=NextResponse.next();source.cookies.set('refreshed','session',{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:3600});source.cookies.set('expired','',{path:'/',maxAge:0});
  for(const target of [NextResponse.redirect('https://example.com/app'),NextResponse.json({error:'expired'},{status:401})]){
   const result=withSessionCookies(source,target);expect(result.cookies.get('refreshed')).toMatchObject({value:'session',httpOnly:true,secure:true,sameSite:'lax',maxAge:3600});expect(result.cookies.get('expired')?.maxAge).toBe(0);expect(result.headers.get('cache-control')).toBe('private, no-store');
  }
 });
 it('shows actionable errors without echoing server details',()=>{
  expect(authErrorMessage({code:'invalid_credentials'})).toContain('邮箱');expect(authErrorMessage({message:key})).not.toContain(key);
 });
});
