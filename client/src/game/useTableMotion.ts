import { useLayoutEffect, useRef, type RefObject } from "react";
import type { PlayerView, ViewCard } from "@cgwf/shared";
import { prefersReducedMotion } from "../settings";

interface Position { x: number; y: number; width: number; height: number }
interface CardPosition { card: ViewCard; rect: Position | null; image: string | null }
interface Snapshot { seq: number; viewer: string | null; cards: Map<string, CardPosition>; libraries: Map<string, number>; lastLogSeq: number | null }

function position(element: Element | null): Position | null {
  if (!element) return null;
  const r = element.getBoundingClientRect();
  if (!r.width || !r.height || r.right <= 0 || r.left >= innerWidth || r.bottom <= 0 || r.top >= innerHeight) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Decorative trails from already-authorized views. Never dispatches or delays game actions. */
export function useTableMotion(root: RefObject<HTMLDivElement | null>, view: PlayerView, connected: boolean) {
  const previous = useRef<Snapshot | null>(null);
  useLayoutEffect(() => {
    const table = root.current;
    if (!table || !connected) { previous.current = null; return; }
    const elements = new Map(Array.from(table.querySelectorAll<HTMLElement>("[data-card-id]"), e => [e.dataset.cardId!, e]));
    const cards = new Map<string, CardPosition>();
    for (const p of Object.values(view.players)) {
      for (const card of [...p.hand.cards, ...p.library.known, ...p.graveyard, ...p.exile, ...p.command, ...Object.values(p.battlefield).flat()]) {
        const element = elements.get(card.iid);
        cards.set(card.iid, { card, rect: position(element ?? null), image: element?.querySelector("img")?.getAttribute("src") ?? null });
      }
    }
    const now: Snapshot = { seq: view.seq, viewer: view.viewer, cards, lastLogSeq: view.log.at(-1)?.seq ?? null, libraries: new Map(Object.values(view.players).map(p => [p.id, p.library.count])) };
    const before = previous.current;
    previous.current = now;
    // Initial load, undo, reconnect, background-tab catch-up and large batches stay still.
    if (typeof table.animate !== "function" || typeof window.matchMedia !== "function" || !before || before.viewer !== now.viewer || view.phase !== "playing" || view.seq <= before.seq || view.seq - before.seq > 8 || document.hidden || prefersReducedMotion() || (before.lastLogSeq !== null && !view.log.some(entry => entry.seq === before.lastLogSeq))) return;
    const animations: Animation[] = [];
    const ghosts: HTMLElement[] = [];
    const zonePosition = (owner: string, zone: string) => position(owner === view.viewer
      ? table.querySelector(`[data-zone="${zone}"]`)
      : Array.from(table.querySelectorAll<HTMLElement>("[data-player-id]")).find(e => e.dataset.playerId === owner) ?? null);
    let count = 0;
    for (const [iid, next] of cards) {
      const old = before.cards.get(iid);
      const fromLibrary = old?.card.zone.kind === "library" || (!old && next.card.owner === view.viewer &&
        (before.libraries.get(next.card.owner) ?? 0) > (now.libraries.get(next.card.owner) ?? 0));
      const drew = fromLibrary && next.card.zone.kind === "hand";
      const arrivedFromLibrary = fromLibrary && ["hand", "graveyard", "exile"].includes(next.card.zone.kind);
      const moved = old && (old.card.zone.kind !== next.card.zone.kind || old.card.zone.owner !== next.card.zone.owner);
      if ((!arrivedFromLibrary && !moved) || count >= 6) continue;
      const destination = next.card.zone.kind;
      const from = fromLibrary ? zonePosition(next.card.owner, "library") : old?.rect ?? (old ? zonePosition(old.card.zone.owner, old.card.zone.kind) : null);
      const to = next.rect ?? zonePosition(next.card.zone.owner, destination);
      if (!from || !to) continue;
      const kind = drew ? "draw" : destination === "graveyard" ? "graveyard" : destination === "exile" ? "exile" : destination === "hand" ? "return" : destination === "battlefield" ? "play" : "move";
      const ghost = document.createElement("div");
      ghost.className = `motion-card motion-${kind} sleeve-classic`;
      ghost.dataset.motion = kind;
      ghost.setAttribute("aria-hidden", "true");
      const width = Math.min(next.rect?.width ?? old?.rect?.width ?? 48, 110);
      const height = width * 88 / 63;
      Object.assign(ghost.style, { left: `${from.x + (from.width - width) / 2}px`, top: `${from.y + (from.height - height) / 2}px`, width: `${width}px`, height: `${height}px` });
      // Reuse only an image previously visible to this viewer. Draws and moves into
      // hidden zones use a sleeve; this effect never fetches or infers a card identity.
      if (!drew && destination !== "library" && old?.image && !old.card.faceDown && (old.card.public || old.card.owner === view.viewer)) {
        const img = document.createElement("img"); img.src = old.image; img.alt = ""; ghost.append(img);
      }
      table.append(ghost); ghosts.push(ghost);
      const dx = to.x + to.width / 2 - from.x - from.width / 2;
      const dy = to.y + to.height / 2 - from.y - from.height / 2;
      const animation = ghost.animate([
        { transform: "translate(0, 0) rotate(-5deg) scale(.94)", opacity: .95 },
        { transform: `translate(${dx * .5}px, ${dy * .5 - 28}px) rotate(${kind === "graveyard" ? -12 : 4}deg) scale(1.05)`, opacity: .95, offset: .5 },
        { transform: `translate(${dx}px, ${dy}px) rotate(0deg) scale(${next.rect ? 1 : .65})`, opacity: 0 },
      ], { duration: kind === "graveyard" ? 460 : 360, easing: "cubic-bezier(.22,.7,.22,1)" });
      animations.push(animation); animation.onfinish = () => ghost.remove();
      const target = elements.get(iid)?.querySelector(".tile-inner") ?? (view.viewer === next.card.zone.owner ? table.querySelector(`[data-zone="${destination}"]`) : null);
      if (target) animations.push(target.animate([{ outline: "2px solid #dfb76d", outlineOffset: "2px" }, { outline: "2px solid transparent", outlineOffset: "5px" }], { duration: 500 }));
      count++;
    }
    const clear = () => { animations.forEach(a => a.cancel()); ghosts.forEach(g => g.remove()); };
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => { if (media.matches) clear(); };
    media.addEventListener("change", onMotion);
    return () => { clear(); media.removeEventListener("change", onMotion); };
  }, [root, view, connected]);
}
