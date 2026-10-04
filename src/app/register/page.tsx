import { Suspense } from "react";
import AuthForm from "../auth/auth-form";
export default function RegisterPage() {
  return <Suspense fallback={<p className="p-8">正在载入注册页面…</p>}><AuthForm mode="register"/></Suspense>;
}
