import { useEffect } from "react";
import { AVATAR_COLORS, type EngineAnswer, type EnginePrompt, type PlayerView, type RoomMember, type StackItem, type StackTargetRef, type ViewCard } from "@cgwf/shared";
import { CardImage } from "../components/CardImage";
import { findCard, nameOf, type Printings } from "./model";

/**
 * Rules-engine tables: what is on the stack. The compact panel sits top-right whenever the stack
 * is not empty (newest on top). When a response is cast on top of something, or a spell targets a
 * stack item, the chain expands into the centred "Interaction Stack" window so everyone can read
 * the chain and the player with priority can respond or let it resolve. Both are overlays on the
 * board; land plays never appear (they never use the stack).
 */

/** A stack item as a card the zoom can show (stack items are public, so the printing is known). */
export function stackItemCard(it: StackItem): ViewCard | null {
  if (!it.printingId) return null;
  return {
    iid: it.sourceIid ?? `stack:${it.id}`,
    printingId: it.printingId,
    custom: null,
    owner: it.controller,
    zone: { kind: "battlefield", owner: it.controller, row: "other" },
    tapped: false,
    faceDown: false,
    face: 0,
    counters: {},
    attachedTo: null,
    isToken: false,
    isCommander: false,
    effect: null,
    modifier: null,
    anthemDismissed: false,
    public: true,
  };
}

/** True when the stack holds a chain worth a window: two or more items, or something aimed at a stack item. */
export function isInteraction(stack: StackItem[]): boolean {
  return stack.length >= 2 || stack.some((it) => (it.targets ?? []).some((t) => t.kind === "stack"));
}

function targetText(t: StackTargetRef, view: PlayerView, printings: Printings): string {
  if (t.kind === "player") return view.players[t.player]?.name ?? "a player";
  if (t.kind === "card") {
    const c = findCard(view, t.iid);
    return c ? nameOf(c, printings) : (t.name ?? "a card");
  }
  return t.name ?? "a spell";
}

function colorOf(members: RoomMember[], userId: string): string {
  const m = members.find((x) => x.userId === userId);
  return m ? AVATAR_COLORS[m.color] : "var(--accent)";
}

function kindLabel(it: StackItem): string {
  return it.kind === "trigger" ? "triggered ability" : it.kind === "ability" ? "ability" : "spell";
}

interface CommonProps {
  stack: StackItem[];
  view: PlayerView;
  printings: Printings;
  members: RoomMember[];
  onZoom: (c: ViewCard) => void;
}

function Thumb({ it }: { it: StackItem }) {
  if (it.printingId) return <CardImage id={it.printingId} name={it.name ?? it.description} size="small" className="stack-thumb" />;
  return <span className="stack-thumb is-blank" aria-hidden="true" />;
}

/** One row of the stack (shared by the panel and the window). */
function StackRow({ it, view, printings, members, onZoom, targeted, big = false }: { it: StackItem; targeted: boolean; big?: boolean } & Omit<CommonProps, "stack">) {
  const who = view.players[it.controller]?.name ?? "?";
  const targets = (it.targets ?? []).map((t) => targetText(t, view, printings));
  const card = stackItemCard(it);
  return (
    <button className={`stack-item${targeted ? " is-targeted" : ""}${big ? " is-big" : ""}`} onClick={() => card && onZoom(card)} title={it.description} aria-label={`${it.name ?? kindLabel(it)}, ${who}${targets.length ? `, targeting ${targets.join(" and ")}` : ""}. Tap to read the card`}>
      <Thumb it={it} />
      <span className="stack-item-text">
        <span className="stack-item-name">{it.name ?? it.description}</span>
        <span className="stack-item-meta">
          <span className="stack-dot" style={{ background: colorOf(members, it.controller) }} aria-hidden="true" />
          {who}
          {it.kind && it.kind !== "spell" ? ` - ${kindLabel(it)}` : ""}
        </span>
        {targets.length > 0 && <span className="stack-item-targets">targeting {targets.join(", ")}</span>}
        {big && it.name && it.description && it.description !== it.name && <span className="stack-item-desc">{it.description}</span>}
      </span>
    </button>
  );
}

/** Compact stack, top-right. */
export function StackPanel({ stack, view, printings, members, onZoom, chain, onOpenChain }: CommonProps & { chain: boolean; onOpenChain: () => void }) {
  if (stack.length === 0) return null;
  const topTargets = new Set((stack[0]?.targets ?? []).filter((t) => t.kind === "stack").map((t) => (t.kind === "stack" ? t.id : "")));
  return (
    <aside className="stack-panel" aria-label={`Stack, ${stack.length} item${stack.length === 1 ? "" : "s"}`}>
      <div className="stack-panel-head">
        <strong>Stack</strong>
        <span className="muted small">{stack.length}</span>
        {chain && (
          <button className="btn btn-small stack-open" onClick={onOpenChain}>
            Interaction
          </button>
        )}
      </div>
      <div className="stack-list">
        {stack.map((it) => (
          <StackRow key={it.id} it={it} view={view} printings={printings} members={members} onZoom={onZoom} targeted={topTargets.has(it.id)} />
        ))}
      </div>
    </aside>
  );
}

/** The centred chain window with the respond / pass controls. */
export function InteractionStack({ stack, view, printings, members, onZoom, prompt, me, answer, onMinimize }: CommonProps & { prompt: EnginePrompt | null; me: string | null; answer: (a: EngineAnswer) => void; onMinimize: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onMinimize();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onMinimize]);
  const top = stack[0];
  const priority = prompt?.kind === "priority" ? prompt : null;
  const waitingOn = (view.engine?.waitingOn ?? []).map((id) => view.players[id]?.name ?? "?");
  const targetedIds = new Set<string>();
  for (const it of stack) for (const t of it.targets ?? []) if (t.kind === "stack") targetedIds.add(t.id);
  return (
    <div className="interaction-backdrop" onClick={onMinimize}>
      <section className="interaction" role="dialog" aria-modal="false" aria-label="Interaction stack" onClick={(e) => e.stopPropagation()}>
        <header className="interaction-head">
          <div>
            <h2>Interaction stack</h2>
            <p className="muted small">{top ? `${view.players[top.controller]?.name ?? "?"}'s ${top.name ?? kindLabel(top)} is on top and resolves first.` : ""}</p>
          </div>
          <button className="sheet-close" onClick={onMinimize} aria-label="Minimise (the stack stays in the corner)">
            &times;
          </button>
        </header>
        <ol className="interaction-chain">
          {stack.map((it, i) => (
            <li key={it.id} className="interaction-step">
              {i > 0 && <span className="interaction-arrow" aria-hidden="true">on top of</span>}
              <StackRow it={it} view={view} printings={printings} members={members} onZoom={onZoom} targeted={targetedIds.has(it.id)} big />
            </li>
          ))}
        </ol>
        <footer className="interaction-foot">
          {priority ? (
            <>
              <span className="muted small">{priority.stackTopMine ? "Your spell is on top." : "You have priority: respond, or let it resolve."}</span>
              <div className="actions">
                <button className="btn" onClick={onMinimize} title="Back to the board to tap a card">
                  Respond
                </button>
                <button className="btn btn-primary" onClick={() => answer({ promptId: priority.promptId, option: null })}>
                  Let it resolve
                </button>
              </div>
            </>
          ) : (
            <span className="muted small">{me && view.players[me] && !view.players[me].eliminated ? (waitingOn.length ? `Waiting for ${waitingOn.join(", ")}.` : "The engine is resolving...") : "Watching."}</span>
          )}
        </footer>
      </section>
    </div>
  );
}
