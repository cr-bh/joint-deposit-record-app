"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
export default function InviteAccept({token,email}:{token:string;email:string}) {
  const router=useRouter(),lock=useRef(false);
  const [message,setMessage]=useState(""),[busy,setBusy]=useState(false);
  async function accept() {
    if(lock.current)return;lock.current=true;setBusy(true);setMessage("");
    try {
      const response=await fetch("/api/invitations/accept",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token})});
      const body=await response.json().catch(()=>({}));
      if(response.status===401){router.replace(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);return;}
      if(!response.ok)throw new Error(body.error||"邀请无效或已过期，请联系第一位成员。");
      router.replace(`/app?household=${encodeURIComponent(body.householdId)}`);router.refresh();
    } catch(error){setMessage(error instanceof Error ? error.message : "网络连接失败，请保留此页面后重试。");}
    finally {lock.current=false;setBusy(false);}
  }
  async function switchAccount() {
    if(lock.current)return;lock.current=true;setBusy(true);setMessage("");
    try {const {error}=await createClient().auth.signOut({scope:"local"});if(error)throw error;router.replace(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);router.refresh();}
    catch {setMessage("退出失败，请稍后重试。");}finally {lock.current=false;setBusy(false);}
  }
  return <main className="grid min-h-screen place-items-center bg-[#f3f2ed] p-4 text-[#1d3029]"><section className="w-full max-w-md rounded-3xl border bg-[#fbfaf6] p-7"><p className="text-xs tracking-widest text-[#587064]">共筑</p><h1 className="mt-2 text-2xl font-bold">加入共同账本</h1><p className="mt-4 rounded-xl bg-[#edf7ed] p-3 text-sm">当前账号：<b className="break-all">{email}</b></p><p className="mt-4 text-sm leading-6 text-gray-600">请使用收到邀请的邮箱。接受后会加入对方已有的账本，不需要另建账本。</p><button disabled={busy} onClick={accept} className="mt-6 w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white disabled:opacity-50">{busy ? "正在处理…" : "接受邀请"}</button><button disabled={busy} onClick={switchAccount} className="mt-3 w-full rounded-xl border py-3 text-sm disabled:opacity-50">换一个账号登录</button>{message&&<p role="alert" className="mt-4 text-sm leading-6 text-red-700">{message}</p>}<Link href="/app" className="mt-4 inline-block text-sm underline">查看我已加入的账本</Link></section></main>;
}
