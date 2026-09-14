"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/auth/redirect";

export default function RegisterPage() {
  return <Suspense fallback={<AuthLoading/>}><RegisterForm/></Suspense>;
}

function RegisterForm() {
  const router = useRouter();
  const search = useSearchParams();
  const nextPath = safeNextPath(search.get("next"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const callbackUrl = new URL("/auth/callback", window.location.origin);
    callbackUrl.searchParams.set("next", nextPath);
    const { data, error } = await createClient().auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: callbackUrl.toString() } });
    setMessage(error ? error.message : "注册请求已提交，请到邮箱完成验证；验证后会继续刚才的操作。");
    if (!error && data.session) router.push(nextPath);
  }
  const loginHref = nextPath === "/" ? "/login" : `/login?next=${encodeURIComponent(nextPath)}`;
  return <main className="grid min-h-screen place-items-center bg-[#f3f2ed] p-4"><form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border bg-white p-7"><div><p className="text-xs tracking-widest text-[#587064]">共筑</p><h1 className="mt-1 text-2xl font-bold">创建独立账号</h1></div><input value={name} onChange={(event) => setName(event.target.value)} required placeholder="显示名称" className="w-full rounded-xl border p-3"/><input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required placeholder="邮箱" className="w-full rounded-xl border p-3"/><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={8} required placeholder="至少 8 位密码" className="w-full rounded-xl border p-3"/><button className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white">注册</button>{message && <p className="text-sm text-[#587064]">{message}</p>}<p className="text-sm">已有账号？<Link href={loginHref} className="font-bold text-[#1f5243]">登录</Link></p></form></main>;
}

function AuthLoading() { return <main className="grid min-h-screen place-items-center bg-[#f3f2ed] p-4"><p className="rounded-2xl border bg-white p-7 text-sm text-gray-500">正在载入注册页面…</p></main>; }
