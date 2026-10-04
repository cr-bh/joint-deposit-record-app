import { Suspense } from "react";
import AuthForm from "../auth/auth-form";
export default function LoginPage() {
  return <Suspense fallback={<p className="p-8">正在载入登录页面…</p>}><AuthForm mode="login"/></Suspense>;
}
