"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { safeNextPath } from "@/lib/auth/redirect";
import type { ConnectionCheck } from "@/lib/supabase/connection-check";
export default function SetupCheck({configured,initialMessage}:{configured:boolean;initialMessage:string}) {
  const next = safeNextPath(useSearchParams().get("next"));
  const [result,setResult] = useState<ConnectionCheck>({configured,auth:"unchecked",database:"unchecked",emailConfirmation:null,message:initialMessage});
  const [busy,setBusy] = useState(false),lock=useRef(false);
  async function check() {
    if(lock.current)return;lock.current=true;setBusy(true);
    try {const response=await fetch("/api/setup/check",{cache:"no-store"});if(!response.ok)throw new Error();setResult(await response.json());}
    catch {setResult(previous=>({...previous,auth:"error",message:"检查暂时失败，请稍后重试。"}));}
    finally {lock.current=false;setBusy(false);}
  }
  const ready = result.auth === "ok" && result.database === "ok";
  return <main className="grid min-h-screen place-items-center bg-[#f3f2ed] p-4 text-[#1d3029]"><section className="w-full max-w-xl rounded-3xl border bg-[#fbfaf6] p-6 sm:p-8"><p className="text-xs tracking-widest text-[#587064]">共筑 · 测试环境</p><h1 className="mt-2 text-2xl font-bold">{ready ? "可以开始真实登录" : "准备共同账本"}</h1><p className="mt-3 text-sm leading-6 text-gray-600">接通后，每位成员使用自己的账号，记录会保存到共同账本。</p><dl className="mt-6 space-y-3 text-sm">{[["连接配置",result.configured ? "已配置" : "待准备"],["登录服务",result.auth === "ok" ? "已连接" : result.auth === "error" ? "连接失败" : "待检查"],["账本基础表",result.database === "ok" ? "检查通过" : result.database === "error" ? "检查未通过" : "待检查"],["注册邮箱验证",result.emailConfirmation === null ? "待检查" : result.emailConfirmation ? "已开启" : "当前未开启"]].map(([title,state])=><div key={title} className="flex justify-between gap-4 rounded-xl border bg-white p-3"><dt>{title}</dt><dd className="font-semibold">{state}</dd></div>)}</dl><p role="status" className="mt-4 rounded-xl bg-[#edf7ed] p-4 text-sm leading-6">{result.message}</p><div className="mt-5 flex flex-wrap gap-3"><button disabled={busy} onClick={check} className="rounded-xl bg-[#1f5243] px-4 py-3 font-bold text-white disabled:opacity-50">{busy ? "正在检查…" : "检查连接"}</button><Link href={`/login?next=${encodeURIComponent(next)}`} className="rounded-xl border px-4 py-3 text-sm font-bold">前往登录</Link>{process.env.NODE_ENV === "development" && <Link href="/preview" className="rounded-xl border px-4 py-3 text-sm">查看只读演示</Link>}</div><p className="mt-4 text-xs leading-5 text-gray-500">连接检查不会注册账号、创建账本或读取资金记录。检查通过后，仍需分别登录验证邀请与成员权限。</p></section></main>;
}
