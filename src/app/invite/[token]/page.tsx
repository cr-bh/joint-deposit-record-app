import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import InviteAccept from "./invite-accept";
export default async function InvitePage({params}:{params:Promise<{token:string}>}) {
  const {token}=await params, supabase=await createClient();
  const {data:{user}}=await supabase.auth.getUser();
  if(!user)redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  return <InviteAccept token={token} email={user.email??""}/>;
}
