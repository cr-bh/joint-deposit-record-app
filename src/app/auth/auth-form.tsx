"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getPublicSupabaseConfig } from "@/lib/supabase/config";
import { safeNextPath } from "@/lib/auth/redirect";
import { authErrorMessage } from "@/lib/auth/errors";

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter(), search = useSearchParams();
  const next = safeNextPath(search.get("next")), config = getPublicSupabaseConfig();
  const [name,setName] = useState(""), [email,setEmail] = useState(""), [password,setPassword] = useState("");
  const [busy,setBusy] = useState(false), [awaitingEmail,setAwaitingEmail] = useState(false), [cooldown,setCooldown] = useState(false);
  const [error,setError] = useState(search.get("error") === "verification_failed" ? "验证链接无效或已过期。请在注册时使用的浏览器打开邮件链接，或重新发送确认邮件。" : "");
  const [message,setMessage] = useState(""), lock = useRef(false);
  const isRegistration = mode === "register";
  const route = (path: string) => `${path}?next=${encodeURIComponent(next)}`;
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown(false),60_000); return () => clearTimeout(timer); },[cooldown]);
  function callback() { const url = new URL("/auth/callback",window.location.origin); url.searchParams.set("next",next); return url.toString(); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (lock.current || !config.ready) return;
    lock.current=true;setBusy(true);setError("");setMessage("");
    try {
      const client = createClient();
      if (isRegistration) {
        const { data,error } = await client.auth.signUp({email:email.trim(),password,options:{data:{display_name:name.trim()},emailRedirectTo:callback()}});
        if (error) throw error;
        setPassword("");
        if (data.session) { router.replace(next);router.refresh(); }
        else { setAwaitingEmail(true);setCooldown(true);setMessage("注册请求已提交。请检查邮箱和垃圾邮件，并在当前浏览器打开验证链接。"); }
      } else {
        const { error } = await client.auth.signInWithPassword({email:email.trim(),password});
        if (error) { if (error.code === "email_not_confirmed") setAwaitingEmail(true); throw error; }
        setPassword("");router.replace(next);router.refresh();
      }
    } catch(error) { setError(authErrorMessage(error)); } finally { lock.current=false;setBusy(false); }
  }
  async function resend() {
    if (lock.current || cooldown || !email.trim() || !config.ready) return;
    lock.current=true;setBusy(true);setError("");setMessage("");
    try {
      const {error} = await createClient().auth.resend({type:"signup",email:email.trim(),options:{emailRedirectTo:callback()}});
      if(error) throw error;
      setCooldown(true);setMessage("已请求重新发送。请检查邮箱和垃圾邮件，并在当前浏览器打开链接。");
    } catch(error) {setError(authErrorMessage(error));} finally {lock.current=false;setBusy(false);}
  }
  return <main className="grid min-h-screen place-items-center bg-[#f3f2ed] p-4 text-[#1d3029]"><section className="w-full max-w-md rounded-3xl border bg-[#fbfaf6] p-6 sm:p-8"><p className="text-xs tracking-widest text-[#587064]">共筑 · 双人共同账本</p><h1 className="mt-2 text-2xl font-bold">{isRegistration ? "创建独立账号" : "登录共同账本"}</h1><p className="mt-3 text-sm leading-6 text-gray-600">每位成员使用自己的邮箱和密码。{next.startsWith("/invite/") ? "登录或验证邮箱后，会继续接受刚才的邀请。" : isRegistration ? "第一位成员创建账本，再邀请另一位成员加入。" : "登录后继续记录、核对和共同审批。"}</p>
    {!config.ready && <div className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900"><b>真实登录尚未接通</b><p className="mt-1">测试环境准备完成后，即可注册和登录。</p><Link className="mt-2 inline-block underline" href={route("/setup")}>查看连接状态</Link></div>}
    <form onSubmit={submit} className="mt-6 space-y-4"><fieldset disabled={busy || !config.ready} className="space-y-4 disabled:opacity-50">{isRegistration && <label className="block text-sm">显示名称<input name="name" autoComplete="nickname" required maxLength={80} value={name} onChange={e=>setName(e.target.value)} className="mt-1 w-full rounded-xl border bg-white p-3"/></label>}<label className="block text-sm">邮箱<input name="email" autoComplete="email" type="email" required value={email} onChange={e=>{setEmail(e.target.value);setAwaitingEmail(false);}} className="mt-1 w-full rounded-xl border bg-white p-3"/></label><label className="block text-sm">密码<input name="password" autoComplete={isRegistration ? "new-password" : "current-password"} type="password" required minLength={isRegistration ? 8 : undefined} value={password} onChange={e=>setPassword(e.target.value)} className="mt-1 w-full rounded-xl border bg-white p-3"/>{isRegistration && <span className="mt-1 block text-xs text-gray-500">至少 8 位；请与另一位成员分别设置。</span>}</label><button disabled={busy || !config.ready || (isRegistration && !name.trim())} className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white disabled:opacity-50">{busy ? "正在处理…" : isRegistration ? "注册账号" : "登录"}</button></fieldset></form>
    {error && <p role="alert" className="mt-4 text-sm leading-6 text-red-700">{error}</p>}{message && <p role="status" className="mt-4 rounded-xl bg-[#edf7ed] p-3 text-sm leading-6">{message}</p>}
    {(awaitingEmail || search.get("error") === "verification_failed") && <button disabled={busy || cooldown || !email.trim() || !config.ready} onClick={resend} className="mt-3 min-h-11 text-sm underline disabled:opacity-50">{cooldown ? "一分钟后可重新发送" : "重新发送确认邮件"}</button>}
    <p className="mt-5 text-sm">{isRegistration ? "已有账号？" : "还没有账号？"}<Link className="ml-1 font-bold underline" href={route(isRegistration ? "/login" : "/register")}>{isRegistration ? "登录" : "注册"}</Link></p>{process.env.NODE_ENV === "development" && <Link href="/preview" className="mt-4 inline-block text-sm text-gray-500 underline">查看只读演示</Link>}
  </section></main>;
}
