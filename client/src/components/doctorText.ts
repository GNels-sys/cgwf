/** "In stock at 2 local stores (from $1.25)"; null when no local store has it or stock is unknown. */
export function stockText(stores: number | null, cheapest: number | null): string | null {
  if (!stores) return null;
  return `In stock at ${stores} local ${stores === 1 ? "store" : "stores"}${cheapest !== null ? ` (from $${cheapest.toFixed(2)})` : ""}`;
}

/** "Claude Opus 5.5 · done · 3 calls, 4 lookups · $0.42 · 2 minutes" for one AI run. */
export function aiRunLine(run: { model: string; servedBy: string | null; status: string; calls: number; toolCalls: number; costUsd: number; startedAt: string; finishedAt: string | null; invalidSubmissions: number }): string {
  const model = run.servedBy && run.servedBy !== run.model ? `${run.servedBy} (fallback from ${run.model})` : run.model;
  const parts = [model, run.status === "running" ? "working" : run.status, `${run.calls} ${run.calls === 1 ? "call" : "calls"}, ${run.toolCalls} tool ${run.toolCalls === 1 ? "use" : "uses"}`, `$${run.costUsd.toFixed(2)}`];
  if (run.invalidSubmissions) parts.push(`${run.invalidSubmissions} answer${run.invalidSubmissions === 1 ? "" : "s"} sent back`);
  if (run.finishedAt) {
    const s = Math.max(1, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
    parts.push(s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);
  }
  return parts.join(" · ");
}
