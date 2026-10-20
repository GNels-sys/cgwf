// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CardPrinting,
  EngineAnswer,
  EngineOption,
  EnginePrompt,
  PlayerView,
  ViewCard,
} from "@cgwf/shared";
import { EngineListSheet, NO_PICK, type EnginePick } from "./Engine";
import {
  actionVerb,
  countLine,
  groupOptions,
  isGroupedChoice,
} from "./choiceGroups";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------- a three-player table (turn order Blair, me, Casey)

const printing = (
  id: string,
  name: string,
  typeLine: string,
  manaCost: string,
  oracleText: string,
) =>
  ({
    id,
    name,
    typeLine,
    manaCost,
    oracleText,
    faces: [{ name, oracleText, typeLine, manaCost }],
  }) as unknown as CardPrinting;
const printings: Record<string, CardPrinting> = {
  rhystic: printing(
    "rhystic",
    "Rhystic Study",
    "Enchantment",
    "{2}{U}",
    "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.",
  ),
  sol: printing("sol", "Sol Ring", "Artifact", "{1}", "{T}: Add {C}{C}."),
  bear: printing("bear", "Grizzly Bears", "Creature — Bear", "{1}{G}", ""),
  forest: printing("forest", "Forest", "Basic Land — Forest", "", ""),
  boots: printing(
    "boots",
    "Swiftfoot Boots",
    "Artifact — Equipment",
    "{2}",
    "Equipped creature has hexproof and haste.",
  ),
  reanimate: printing(
    "reanimate",
    "Reanimate",
    "Sorcery",
    "{B}",
    "Put target creature card from a graveyard onto the battlefield under your control.",
  ),
};
const vc = (
  iid: string,
  printingId: string,
  owner: string,
  row: string | null,
  extra: Partial<ViewCard> = {},
): ViewCard =>
  ({
    iid,
    printingId,
    custom: null,
    owner,
    zone: row
      ? { kind: "battlefield", owner, row }
      : { kind: "graveyard", owner },
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
    ...extra,
  }) as ViewCard;
const rows = (cards: ViewCard[]) => ({
  other: [],
  creatures: cards.filter(
    (c) => c.zone.kind === "battlefield" && c.zone.row === "creatures",
  ),
  enchantments: cards.filter(
    (c) => c.zone.kind === "battlefield" && c.zone.row === "enchantments",
  ),
  lands: cards.filter(
    (c) => c.zone.kind === "battlefield" && c.zone.row === "lands",
  ),
  artifacts: cards.filter(
    (c) => c.zone.kind === "battlefield" && c.zone.row === "artifacts",
  ),
});
const player = (
  id: string,
  name: string,
  life: number,
  bf: ViewCard[],
  graveyard: ViewCard[] = [],
) => ({
  id,
  name,
  life,
  battlefield: rows(bf),
  graveyard,
  exile: [],
  command: [],
  hand: { cards: [], count: 3 },
  library: { known: [], count: 90 },
  commanderDamage: {},
  counters: {},
});
const view = {
  viewer: "me",
  turnOrder: ["blair", "me", "casey"],
  players: {
    blair: player("blair", "Blair", 31, [
      vc("10", "rhystic", "blair", "enchantments"),
      vc("11", "sol", "blair", "artifacts"),
      vc("12", "bear", "blair", "creatures", { counters: { "+1/+1": 2 } }),
      vc("13", "boots", "blair", "artifacts", { attachedTo: "12" }),
    ]),
    me: player("me", "Georgie", 40, [vc("20", "forest", "me", "lands")]),
    casey: player(
      "casey",
      "Casey",
      22,
      [],
      [vc("30", "reanimate", "casey", null)],
    ),
  },
  stack: [],
} as unknown as PlayerView;

const card = (
  index: number,
  iid: string,
  name: string,
  zone: string,
  controller: string,
  printingId: string,
  extra: object = {},
): EngineOption =>
  ({
    kind: "card",
    index,
    iid,
    name,
    zone,
    controller,
    owner: controller,
    printingId,
    tapped: false,
    power: null,
    toughness: null,
    ...extra,
  }) as EngineOption;
const exile: Extract<EnginePrompt, { kind: "targets" }> = {
  kind: "targets",
  promptId: 41,
  title: "Choose targets for Vandalblast-ish",
  ability: "Exile one or two target nonland permanents or cards in graveyards.",
  source: "Test Spell",
  min: 1,
  max: 2,
  options: [
    card(0, "10", "Rhystic Study", "battlefield", "blair", "rhystic"),
    card(1, "11", "Sol Ring", "battlefield", "blair", "sol"),
    card(2, "12", "Grizzly Bears", "battlefield", "blair", "bear", {
      power: 4,
      toughness: 4,
    }),
    card(3, "30", "Reanimate", "graveyard", "casey", "reanimate"),
    card(4, "20", "Forest", "battlefield", "me", "forest"),
    { kind: "player", index: 5, player: "blair", name: "Blair", life: 31 },
    { kind: "spell", index: 6, label: "Counterspell", iid: "99", stackId: 3 },
  ],
};

describe("grouping options by player and zone", () => {
  it("orders players from the viewer in turn order, then zones by section; player targets sit in their section; the stack apart", () => {
    const g = groupOptions(exile.options, view, "me", printings);
    expect(g.players.map((p) => p.name)).toEqual(["Georgie", "Casey", "Blair"]);
    const blair = g.players.find((p) => p.player === "blair")!;
    expect(blair.playerOption?.index).toBe(5);
    expect(
      blair.sections.map((s) => [s.label, s.options.map((o) => o.index)]),
    ).toEqual([
      ["Creatures", [2]],
      ["Artifacts", [1]],
      ["Enchantments", [0]],
    ]);
    expect(
      g.players.find((p) => p.player === "casey")!.sections.map((s) => s.label),
    ).toEqual(["Graveyard"]);
    expect(g.players[0]!.isYou).toBe(true);
    expect(g.stack.map((o) => o.index)).toEqual([6]);
  });
  it("hides players with nothing to choose and recognises which prompts get the grouped list", () => {
    const g = groupOptions([exile.options[0]!], view, "me", printings);
    expect(g.players.map((p) => p.name)).toEqual(["Blair"]);
    expect(isGroupedChoice(exile)).toBe(true);
    expect(
      isGroupedChoice({
        kind: "choose",
        promptId: 1,
        title: "Pick a colour",
        optional: false,
        source: null,
        options: [{ kind: "text", index: 0, label: "Blue" }],
      }),
    ).toBe(false);
    expect(
      isGroupedChoice({
        kind: "chooseMany",
        promptId: 1,
        title: "Bottom",
        min: 1,
        max: 1,
        source: null,
        options: [exile.options[0]!],
        reason: "mulligan",
      }),
    ).toBe(false);
  });
  it("names the action and the count", () => {
    expect(actionVerb(exile)).toBe("Exile");
    expect(countLine(1, 2, 0)).toBe("0 of 2 chosen · 1 to 2");
    expect(countLine(0, 1, 1)).toBe("1 of 1 chosen · up to 1");
    expect(countLine(2, 2, 1)).toBe("1 of 2 chosen · choose exactly 2");
  });
});

// ---------------------------------------------------------------- the sheet itself

let root: Root;
let host: HTMLElement;
let answers: EngineAnswer[];
let tableTap: (index: number) => void = () => {};

function Harness({ prompt }: { prompt: EnginePrompt }) {
  const [pick, setPick] = useState<EnginePick>(NO_PICK);
  // the table's glowing-card shortcut changes the same pick state (Table.tsx tapCard)
  tableTap = (index) =>
    setPick((p) => ({
      kind: "select",
      picked: [...(p.kind === "select" ? p.picked : []), index],
    }));
  return (
    <EngineListSheet
      prompt={prompt}
      view={view}
      printings={printings}
      pick={pick}
      setPick={setPick}
      answer={(a) => answers.push(a)}
      onClose={() => {}}
      onZoom={() => {}}
      members={[]}
      me="me"
    />
  );
}
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...host.querySelectorAll(sel)] as HTMLElement[];
const click = (el: Element | null | undefined) =>
  act(() => (el as HTMLElement).click());
const row = (name: string) =>
  qa(".choice-row").find((r) =>
    r.querySelector(".choice-name")?.textContent?.startsWith(name),
  )!;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  answers = [];
  act(() => root.render(<Harness prompt={exile} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the grouped choice sheet", () => {
  it("shows one section per player (you first) with zones, the player target at the top of theirs, and the stack", () => {
    expect(qa(".choice-player-head strong").map((e) => e.textContent)).toEqual([
      "You (Georgie)",
      "Casey",
      "Blair",
      "On the stack",
    ]);
    const blair = qa(".choice-player").find(
      (s) => s.getAttribute("aria-label") === "Blair",
    )!;
    expect(blair.querySelector(".choice-list .choice-name")?.textContent).toBe(
      "Blair",
    ); // the player row comes first
    expect(
      [...blair.querySelectorAll(".choice-zone-head")].map((e) =>
        e.textContent?.replace(/[▾▸]/g, "").trim(),
      ),
    ).toEqual(["Creatures 1", "Artifacts 1", "Enchantments 1"]);
  });

  it("rows carry type, P/T and counters; Read shows the oracle text without selecting", () => {
    const bear = row("Grizzly Bears");
    expect(bear.querySelector(".choice-type")?.textContent).toBe(
      "Creature — Bear",
    );
    expect(bear.querySelector(".choice-facts")?.textContent).toContain("4/4");
    expect(bear.querySelector(".choice-facts")?.textContent).toContain(
      "2 +1/+1",
    );
    expect(bear.querySelector(".choice-facts")?.textContent).toContain(
      "with Swiftfoot Boots",
    );
    const rhystic = row("Rhystic Study");
    click(rhystic.querySelector(".choice-read"));
    expect(rhystic.querySelector(".choice-oracle")?.textContent).toContain(
      "Whenever an opponent casts a spell",
    );
    expect(rhystic.classList.contains("is-selected")).toBe(false);
    expect((q(".optional-confirm") as HTMLButtonElement).disabled).toBe(true);
    click(rhystic.querySelector(".choice-thumb")); // looking at the card does not select it either
    expect(row("Rhystic Study").classList.contains("is-selected")).toBe(false);
  });

  it("selection is obvious, counted, and the primary button names it; min is enforced", () => {
    const primary = q(".optional-confirm") as HTMLButtonElement;
    expect(primary.textContent).toBe("Choose targets");
    expect(q(".choice-counter")?.textContent).toBe("0 of 2 chosen · 1 to 2");
    click(row("Rhystic Study").querySelector(".choice-main"));
    click(row("Sol Ring").querySelector(".choice-main"));
    expect(row("Rhystic Study").classList.contains("is-selected")).toBe(true);
    expect(q(".choice-counter")?.textContent).toBe("2 of 2 chosen · 1 to 2");
    expect(primary.textContent).toBe("Exile Rhystic Study and Sol Ring");
    click(primary);
    expect(answers).toEqual([{ promptId: 41, options: [0, 1] }]);
  });

  it("a tap on a glowing card on the table updates the sheet", () => {
    act(() => tableTap(3));
    expect(row("Reanimate").classList.contains("is-selected")).toBe(true);
    expect(q(".optional-confirm")?.textContent).toBe("Exile Reanimate");
  });

  it("sections collapse and expand", () => {
    const head = qa(".choice-player-head").find((h) =>
      h.textContent?.includes("Casey"),
    )!;
    click(head);
    expect(row("Reanimate")).toBeUndefined();
    click(head);
    expect(row("Reanimate")).toBeDefined();
  });
});
