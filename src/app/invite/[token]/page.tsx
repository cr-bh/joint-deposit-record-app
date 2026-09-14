"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [accepting, setAccepting] = useState(false);
  async function accept() {
    if (accepting) return;
    setAccepting(true);
    setMessage("");
    try {
      const { token } = await params;
      const response = await fetch("/api/invitations/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return setMessage(body.error || "邀请无效、已过期或已被使用");
      router.push("/app");
      router.refresh();
    } catch {
      setMessage("网络连接失败，请保留此页面后重试");
    } finally {
      setAccepting(false);
    }
  }
  return <main className="grid min-h-screen place-items-center bg-[#f3f2ed] p-4"><section className="w-full max-w-md rounded-2xl border bg-white p-7"><p className="text-xs tracking-widest text-[#587064]">共筑</p><h1 className="mt-1 text-2xl font-bold">加入共同账本</h1><p className="mt-3 text-sm leading-6 text-gray-500">请确认当前登录邮箱与邀请发送的邮箱一致。接受后，你将成为该共同账本的第二位成员。</p><button disabled={accepting} onClick={accept} className="mt-6 w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-60">{accepting ? "正在接受…" : "接受邀请"}</button>{message && <p className="mt-3 text-sm text-red-700">{message}</p>}</section></main>;
}
