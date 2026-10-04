import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest,NextResponse} from 'next/server';
const mocks=vi.hoisted(()=>({config:vi.fn(),session:vi.fn()}));
vi.mock('@/lib/supabase/config',()=>({getPublicSupabaseConfig:mocks.config}));
vi.mock('@/lib/supabase/middleware',()=>({updateSession:mocks.session}));
import {proxy} from '@/proxy';
beforeEach(()=>{mocks.config.mockReset().mockReturnValue({ready:true,url:'https://example.supabase.co',key:'public'});mocks.session.mockReset().mockResolvedValue({response:NextResponse.next(),user:null,unavailable:false});});
const request=(path:string)=>new NextRequest(`http://127.0.0.1:3000${path}`);
describe('Auth response routing',()=>{
 it('allows static resources before checking configuration or session',async()=>{
  mocks.config.mockReturnValue({ready:false,reason:'missing'});
  expect((await proxy(request('/_next/static/chunks/page.js'))).headers.get('location')).toBeNull();expect(mocks.session).not.toHaveBeenCalled();
 });
 it('returns JSON 401 for private APIs and carries cookie deletion',async()=>{
  const source=NextResponse.next();source.cookies.set('expired','',{path:'/',maxAge:0});mocks.session.mockResolvedValue({response:source,user:null,unavailable:false});
  const result=await proxy(request('/api/households'));expect(result.status).toBe(401);expect(result.headers.get('location')).toBeNull();expect(await result.json()).toMatchObject({error:expect.any(String)});expect(result.cookies.get('expired')?.maxAge).toBe(0);
 });
 it('preserves an invitation and query through the login redirect',async()=>{
  const result=await proxy(request('/invite/token?entry=abc'));const url=new URL(result.headers.get('location')!);expect(url.pathname).toBe('/login');expect(url.searchParams.get('next')).toBe('/invite/token?entry=abc');
 });
 it('carries refreshed sessions when an authenticated user returns to the invite',async()=>{
  const source=NextResponse.next();source.cookies.set('refreshed','session',{path:'/',httpOnly:true});mocks.session.mockResolvedValue({response:source,user:{id:'member'},unavailable:false});
  const result=await proxy(request('/register?next=%2Finvite%2Ftoken'));expect(new URL(result.headers.get('location')!).pathname).toBe('/invite/token');expect(result.cookies.get('refreshed')?.value).toBe('session');
 });
 it('reports Auth outages as 503 for APIs and as setup for pages',async()=>{
  mocks.session.mockResolvedValue({response:NextResponse.next(),user:null,unavailable:true});expect((await proxy(request('/api/households'))).status).toBe(503);expect(new URL((await proxy(request('/app'))).headers.get('location')!).pathname).toBe('/setup');
 });
 it('keeps public login usable and gives actionable responses without configuration',async()=>{
  mocks.config.mockReturnValue({ready:false,reason:'missing'});expect((await proxy(request('/login'))).headers.get('location')).toBeNull();expect((await proxy(request('/api/households'))).status).toBe(503);expect(new URL((await proxy(request('/app'))).headers.get('location')!).pathname).toBe('/setup');expect(mocks.session).not.toHaveBeenCalled();
 });
});
