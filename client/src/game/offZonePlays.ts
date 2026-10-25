import type { EnginePlayable, EnginePrompt, PlayerId, PlayerView, ViewCard } from "@cgwf/shared";

/** A card the seat may play right now that is not in its hand or on a battlefield (so nothing on the table glows for it). */
export interface OffZonePlay {
  card: ViewCard;
  options: EnginePlayable[];
  /** Where it is, in words: "Your exile", "Blair's exile", "Your graveyard", "Your command zone", "Top of your library". */
  where: string;
  /** The zone kind, for the zone button badges. */
  zone: "exile" | "graveyard" | "command" | "library";
  /** Whose zone it sits in. */
  owner: PlayerId;
}

const ZONE_WORDS: Record<OffZonePlay["zone"], string> = { exile: "exile", graveyard: "graveyard", command: "command zone", library: "library" };

/**
 * Owner report 2026-10-25 (Fire Lord Zuko deck): Party Thrasher and Inside Information made cards playable from
 * exile, the engine offered them, but nothing on screen showed them (Inside Information's cards sit in the
 * OPPONENT's exile). This lists every priority option whose card is in an exile, a graveyard, a command zone or
 * a known library card, mine first, then the other players in turn order; the priority bar shows them as
 * buttons and the zone buttons count them.
 */
export function offZonePlays(prompt: EnginePrompt | null, view: PlayerView, me: PlayerId): OffZonePlay[] {
  if (!prompt || prompt.kind !== "priority" || prompt.options.length === 0) return [];
  const byIid = new Map<string, EnginePlayable[]>();
  for (const o of prompt.options) byIid.set(o.iid, [...(byIid.get(o.iid) ?? []), o]);
  const order = [me, ...view.turnOrder.filter((p) => p !== me), ...Object.keys(view.players).filter((p) => p !== me && !view.turnOrder.includes(p))];
  const out: OffZonePlay[] = [];
  for (const pid of order) {
    const p = view.players[pid];
    if (!p) continue;
    const mine = pid === me;
    const whose = mine ? "Your" : `${p.name}'s`;
    const zones: Array<[OffZonePlay["zone"], ViewCard[]]> = [["exile", p.exile], ["graveyard", p.graveyard], ["command", p.command], ["library", p.library.known]];
    for (const [zone, cards] of zones) {
      for (const card of cards) {
        const options = byIid.get(card.iid);
        if (!options) continue;
        byIid.delete(card.iid);
        const where = zone === "library" ? (mine ? "Top of your library" : `Top of ${p.name}'s library`) : `${whose} ${ZONE_WORDS[zone]}`;
        out.push({ card, options, where, zone, owner: pid });
      }
    }
  }
  return out;
}

/** How many of my own zone's cards are playable, for the badge on that zone button. */
export function playableIn(plays: OffZonePlay[], me: PlayerId, zone: OffZonePlay["zone"]): number {
  return plays.filter((p) => p.owner === me && p.zone === zone).length;
}

/** The cost line under a play button: "Pay 1 life", "{1}{R}", "no cost". */
export function playCostLabel(o: EnginePlayable): string {
  const cost = (o.cost ?? "").replace(/^\{0\},\s*/, "").trim();
  return o.kind === "land" ? "Play land" : cost || "no cost";
}
