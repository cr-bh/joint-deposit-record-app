"use client";
import { useRouter } from "next/navigation";
import { useRef, useSyncExternalStore, useState } from "react";
import Link from "next/link";
const subscribe = () => () => {};
export default function OnboardingPage() {
  const router=useRouter(), browserZone=useSyncExternalStore(subscribe,()=>Intl.DateTimeFormat().resolvedOptions().timeZone,()=>"UTC");
  const [zoneOverride,setTimeZone]=useState(""),[name,setName]=useState(""),[currency,setCurrency]=useState("USD");
  const [message,setMessage]=useState(""),[busy,setBusy]=useState(false),lock=useRef(false);
  const [key]=useState(()=>crypto.randomUUID()),timeZone=zoneOverride||browserZone;
  async function create(event:React.FormEvent) {
    event.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setMessage("");
    try {
      const response=await fetch("/api/households",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,reportingCurrency:currency,timeZone,idempotencyKey:key})});
      const body=await response.json().catch(()=>({}));
      if(response.status===401){router.replace("/login?next=%2Fonboarding");return;}
      if(!response.ok)throw new Error(body.error||"创建失败，请重试。");
      router.replace(`/app?household=${encodeURIComponent(body.id)}`);router.refresh();
    } catch(error){setMessage(`${error instanceof Error ? error.message : "网络连接失败。"} 输入已保留，重试不会重复创建账本。`);}
    finally {lock.current=false;setBusy(false);}
  }
  return <main className="grid min-h-screen place-items-center bg-[#f3f2ed] p-4 text-[#1d3029]"><form onSubmit={create} className="w-full max-w-md space-y-4 rounded-3xl border bg-[#fbfaf6] p-7"><div><p className="text-xs tracking-widest text-[#587064]">共筑</p><h1 className="mt-2 text-2xl font-bold">创建你们的共同账本</h1><p className="mt-3 text-sm leading-6 text-gray-600">由第一位成员创建，再邀请另一位成员加入。新账本没有演示记录。</p></div><fieldset disabled={busy} className="space-y-4"><label className="block text-sm">账本名称<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder="例如：我们的共同账户" className="mt-1 w-full rounded-xl border bg-white p-3"/></label><label className="block text-sm">报告币种<select value={currency} onChange={e=>setCurrency(e.target.value)} className="mt-1 w-full rounded-xl border bg-white p-3"><option>USD</option><option>CNY</option><option>HKD</option></select></label><label className="block text-sm">账本时区<input required value={timeZone} onChange={e=>setTimeZone(e.target.value)} className="mt-1 w-full rounded-xl border bg-white p-3"/><span className="mt-1 block text-xs leading-5 text-gray-500">默认当前设备时区；双方共用此时区记录发生日期。</span></label><button disabled={busy || !name.trim()} className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white disabled:opacity-50">{busy ? "正在创建…" : "创建空账本"}</button></fieldset>{message&&<p role="alert" className="text-sm leading-6 text-red-700">{message}</p>}<p className="text-xs leading-5 text-gray-500">如果你是受邀成员，请打开对方发给你的邀请链接加入同一账本。</p><Link href="/login" className="inline-block text-sm underline">返回账号入口</Link></form></main>;
}
