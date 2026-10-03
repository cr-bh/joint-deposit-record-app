import { sankey, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from "d3-sankey";
import type { FlowEdge, FlowGraph, FlowNode } from "@/lib/domain/spending-report";

const money = (value: number, currency: string) => `${currency} ${new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value / 100)}`;
const colors = ["#1f5243", "#768958", "#b79b61"];

export default function SpendingSankey({ graph, currency, refund = false, select }: { graph: FlowGraph; currency: string; refund?: boolean; select: (edge: FlowEdge, title: string) => void }) {
  if (!graph.links.length) return <p className="py-8 text-center text-sm text-gray-500">{refund ? "所选范围暂无退款。" : "所选范围暂无消费发生额。"}</p>;
  const count = Math.max(...[0, 1, 2].map(layer => graph.nodes.filter(n => n.layer === layer).length));
  const height = Math.max(270, count * 52 + 50);
  const layout = sankey<FlowNode, FlowEdge>().nodeId(n => n.id).nodeWidth(12).nodePadding(26).nodeAlign(n => n.layer).extent([[120, 30], [620, height - 25]])({ nodes: graph.nodes.map(n => ({ ...n })), links: graph.links.map(l => ({ ...l })) });
  const name = (node: number | string | SankeyNode<FlowNode, FlowEdge>) => typeof node === "object" ? node.name : String(node);
  const title = (edge: SankeyLink<FlowNode, FlowEdge>) => `${name(edge.source)} → ${name(edge.target)} · ${money(edge.value, currency)}`;
  return <div>
    <p className="mb-2 text-xs text-gray-500">{refund ? "原消费类别 → 退款去向" : "资金支付来源 → 消费用途类别 → 具体事项"} · 点击流线或下方金额查看原始记录</p>
    <div className="overflow-x-auto rounded-xl bg-[#fafbf8]">
      <svg role="img" aria-label={refund ? "退款流向桑基图" : "消费发生额桑基图"} viewBox={`0 0 760 ${height}`} className="w-full min-w-[720px]" style={{ height }}>
        {layout.links.map(edge => <path key={edge.id} d={sankeyLinkHorizontal<FlowNode, FlowEdge>()(edge) ?? ""} fill="none" stroke={refund ? "#b87557" : "#749b85"} strokeOpacity={0.4} strokeWidth={Math.max(4, edge.width ?? 0)} className="cursor-pointer transition-opacity hover:opacity-70 focus-visible:outline-none" role="button" tabIndex={0} aria-label={title(edge)} onClick={() => select(edge, title(edge))} onKeyDown={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); select(edge, title(edge)); } }}><title>{title(edge)}</title></path>)}
        {layout.nodes.map(node => <g key={node.id}><rect x={node.x0} y={node.y0} width={12} height={Math.max(2, (node.y1 ?? 0) - (node.y0 ?? 0))} rx={3} fill={refund ? "#b87557" : colors[node.layer]}/><text x={node.layer === 0 ? (node.x0 ?? 0) - 8 : (node.x1 ?? 0) + 8} y={((node.y0 ?? 0) + (node.y1 ?? 0)) / 2} textAnchor={node.layer === 0 ? "end" : "start"} dominantBaseline="middle" fontSize={12} fill="#1d3029">{node.name.length > 12 ? node.name.slice(0, 11) + "…" : node.name}<title>{`${node.name} · ${money(node.value ?? 0, currency)}`}</title></text></g>)}
      </svg>
    </div>
    <details className="mt-3 text-sm"><summary className="cursor-pointer text-gray-600">流量明细（与图表同一金额）</summary><div className="mt-2 divide-y">{layout.links.map(edge => <button key={edge.id} onClick={() => select(edge, title(edge))} className="block w-full py-3 text-left text-sm underline decoration-[#1f5243]/30 underline-offset-4">{title(edge)}</button>)}</div></details>
  </div>;
}
