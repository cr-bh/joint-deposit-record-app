import { AlertCircle, CheckCircle2, CircleX, Clock, Undo2 } from "lucide-react";

const statuses = {
  pending_approval: { label: "待审批", Icon: Clock, style: "bg-amber-50 text-amber-800 ring-amber-200" },
  overdue_pending: { label: "逾期待审批", Icon: AlertCircle, style: "bg-orange-50 text-orange-800 ring-orange-200" },
  approved: { label: "已批准", Icon: CheckCircle2, style: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  rejected: { label: "已驳回", Icon: CircleX, style: "bg-rose-50 text-rose-800 ring-rose-200" },
  withdrawn: { label: "已撤回", Icon: Undo2, style: "bg-slate-100 text-slate-600 ring-slate-200" },
};

export default function ApprovalStatus({ status }: { status: string }) {
  const { label, Icon, style } = statuses[status as keyof typeof statuses] ?? { label: "待核对", Icon: AlertCircle, style: "bg-slate-100 text-slate-600 ring-slate-200" };
  return <span aria-label={`审批状态：${label}`} className={`inline-flex shrink-0 items-center gap-1.5 self-start whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset ${style}`}><Icon size={14} aria-hidden="true"/>{label}</span>;
}
