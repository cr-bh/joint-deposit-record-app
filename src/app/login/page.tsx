"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/auth/redirect";

export default function LoginPage() {
  return <Suspense fallback={<AuthLoading/>}><LoginForm/></Suspense>;
}

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const nextPath = safeNextPath(search.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(search.get("error") === "verification_failed" ? "邮箱验证链接无效或已过期，请重新登录" : "");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const { error } = await createClient().auth.signInWithPassword({ email, password });
    setMessage(error ? error.message : "登录成功，正在进入共同账本。");
    if (!error) router.push(nextPath);
  }
  const registerHref = nextPath === "/" ? "/register" : `/register?next=${encodeURIComponent(nextPath)}`;
  return <main className="grid min-h-screen place-items-center bg-[#f3f2ed] p-4"><form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border bg-white p-7"><div><p className="text-xs tracking-widest text-[#587064]">共筑</p><h1 className="mt-1 text-2xl font-bold">登录共同账本</h1></div><input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required placeholder="邮箱" className="w-full rounded-xl border p-3"/><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required placeholder="密码" className="w-full rounded-xl border p-3"/><button className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white">登录</button>{message && <p className="text-sm text-[#587064]">{message}</p>}<p className="text-sm">还没有账号？<Link href={registerHref} className="font-bold text-[#1f5243]">注册</Link></p></form></main>;
}

function AuthLoading() { return <main className="grid min-h-screen place-items-center bg-[#f3f2ed] p-4"><p className="rounded-2xl border bg-white p-7 text-sm text-gray-500">正在载入登录页面…</p></main>; }
