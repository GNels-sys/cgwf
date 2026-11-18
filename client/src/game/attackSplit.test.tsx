// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineAnswer, EngineEntityRef, EngineOptionCard, EnginePrompt, PlayerView } from "@cgwf/shared";
import { AttackSplitSheet } from "./AttackSplit";
import { EngineBar, initialPick, type EnginePick } from "./Engine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Owner request 2026-11-18: "attack all" at one player in one press, and "30 of the 110 at Player A, 30 at
 * Player B" by number instead of a tap per token. A real render of the attack bar and the sheet it opens.
 */
const empty = { other: [], creatures: [], enchantments: [], lands: [], artifacts: [] };
const seat = (id: string, name: string) => ({ id, name, exile: [], graveyard: [], command: [], library: { count: 80, known: [] }, hand: { count: 0, cards: [] }, battlefield: empty });
const view = { viewer: "me", turn: 12, turnOrder: ["me", "alex", "blair"], players: { me: seat("me", "Georgie"), alex: seat("alex", "Alex"), blair: seat("blair", "Blair") } } as unknown as PlayerView;
const alex: EngineEntityRef = { kind: "player", player: "alex", name: "Alex" };
const blair: EngineEntityRef = { kind: "player", player: "blair", name: "Blair" };
const token = (i: number, canAttack: EngineEntityRef[]): EngineOptionCard => ({ kind: "card", index: i, iid: `s${i}`, name: "Saproling", printingId: null, zone: "battlefield", controller: "me", owner: "me", tapped: false, power: 1, toughness: 1, canAttack });
const promptFor = (defenders: EngineEntityRef[]): Extract<EnginePrompt, { kind: "attackers" }> => ({ kind: "attackers", promptId: 7, title: "Declare attackers", candidates: Array.from({ length: 110 }, (_, i) => token(i, defenders)), defenders });

function Harness({ prompt, sent }: { prompt: Extract<EnginePrompt, { kind: "attackers" }>; sent: EngineAnswer[] }) {
  const [pick, setPick] = useState<EnginePick>(initialPick(prompt));
  const [open, setOpen] = useState(false);
  return (
    <>
      <EngineBar prompt={prompt} view={view} printings={{}} members={[]} me="me" pick={pick} setPick={setPick} answer={(a) => sent.push(a)} onZoom={() => {}} openList={() => {}} openSplit={() => setOpen(true)} />
      {open && pick.kind === "attack" && <AttackSplitSheet prompt={prompt} view={view} printings={{}} members={[]} targets={pick.targets} setTargets={(targets) => setPick({ kind: "attack", targets, current: pick.current })} answer={(a) => sent.push(a)} onClose={() => setOpen(false)} />}
    </>
  );
}

describe("attacking with a hundred tokens", () => {
  let host: HTMLDivElement;
  let root: Root;
  const sent: EngineAnswer[] = [];
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    sent.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = (text: RegExp, within: ParentNode = host) => [...within.querySelectorAll("button")].find((b) => text.test(b.textContent ?? ""))!;
  const type = (input: HTMLInputElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const attacksAt = (d: EngineEntityRef) => ((sent[0] as { attacks: Array<{ defender: EngineEntityRef }> }).attacks ?? []).filter((a) => a.defender === d).length;

  it("one opponent left: 'All attack Alex' and Declare, two presses", () => {
    act(() => root.render(<Harness prompt={promptFor([alex])} sent={sent} />));
    expect(button(/^Declare/).disabled).toBe(true);
    act(() => button(/All attack Alex \(110\)/).click());
    expect(button(/^Declare/).textContent).toContain("110 attackers");
    act(() => button(/^Declare/).click());
    expect(sent).toHaveLength(1);
    expect(attacksAt(alex)).toBe(110);
  });
  it("'Clear' takes them all back", () => {
    act(() => root.render(<Harness prompt={promptFor([alex, blair])} sent={sent} />));
    expect(button(/^Clear$/)).toBeUndefined();
    act(() => button(/All attack Alex/).click());
    act(() => button(/^Clear$/).click());
    expect(button(/^Declare/).disabled).toBe(true);
  });
  it("by number: 30 at Alex, the rest at Blair, declared from the sheet", () => {
    act(() => root.render(<Harness prompt={promptFor([alex, blair])} sent={sent} />));
    act(() => button(/Send by number/).click());
    const sheet = host.querySelector<HTMLElement>(".attack-split")!;
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.querySelectorAll(".split-group")).toHaveLength(1); // 110 tokens, one row
    expect(sheet.querySelector(".split-group")!.textContent).toContain("Saproling 1/1");
    const inputs = [...sheet.querySelectorAll<HTMLInputElement>(".split-input")];
    expect(inputs.map((i) => i.getAttribute("aria-label"))).toEqual(["Saproling attacking Alex, of 110 available", "Saproling attacking Blair, of 110 available"]);
    type(inputs[0]!, "30");
    expect(inputs[0]!.value).toBe("30");
    expect(sheet.querySelector(".split-group-head")!.textContent).toContain("80 not attacking");
    act(() => button(/Rest \(80\)/, sheet.querySelectorAll(".split-cell")[1]!).click());
    expect(inputs[1]!.value).toBe("80");
    expect(sheet.querySelector(".split-group-head")!.textContent).toContain("all attacking");
    // the bar behind the sheet shows the same numbers on the player chips
    expect([...host.querySelectorAll(".combat-chip-count")].map((c) => c.textContent)).toEqual(["30", "80"]);
    act(() => button(/Declare 110 attackers/, sheet).click());
    expect(sent).toHaveLength(1);
    expect([attacksAt(alex), attacksAt(blair)]).toEqual([30, 80]);
    expect(host.querySelector(".attack-split")).toBeNull();
  });
  it("a number larger than what is left is cut down, and closing declares nothing", () => {
    act(() => root.render(<Harness prompt={promptFor([alex, blair])} sent={sent} />));
    act(() => button(/Send by number/).click());
    const sheet = host.querySelector<HTMLElement>(".attack-split")!;
    const inputs = [...sheet.querySelectorAll<HTMLInputElement>(".split-input")];
    type(inputs[0]!, "100");
    type(inputs[1]!, "999");
    expect(inputs.map((i) => i.value)).toEqual(["100", "10"]);
    act(() => button(/Split evenly/, sheet).click());
    expect(inputs.map((i) => i.value)).toEqual(["55", "55"]);
    act(() => button(/Back to the table/, sheet).click());
    expect(sent).toEqual([]);
    expect(host.querySelector(".attack-split")).toBeNull();
    expect(button(/^Declare/).textContent).toContain("110 attackers"); // the numbers were kept
  });
});
