// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineAnswer, EnginePrompt, PlayerView } from "@cgwf/shared";
import { EngineListSheet, NO_PICK, type EnginePick } from "./Engine";
import {
  canConfirm,
  choiceLabel,
  isOptionalChoice,
  noneAnswer,
  noneQuestion,
} from "./optionalChoice";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Cloud, Ex-SOLDIER's trigger as the bridge sent it to the owner on 2026-10-20 (room 7W4KD3). */
const cloud: Extract<EnginePrompt, { kind: "targets" }> = {
  kind: "targets",
  promptId: 826,
  title: "Choose targets for Cloud, Ex-SOLDIER",
  ability:
    "When Cloud enters, attach up to one target Equipment you control to it.",
  source: "Cloud, Ex-SOLDIER",
  min: 0,
  max: 1,
  options: [
    {
      index: 0,
      kind: "card",
      iid: "77",
      name: "Bloodforged Battle-Axe",
      zone: "Battlefield",
      controller: "me",
      printingId: null,
      power: null,
      toughness: null,
    } as never,
  ],
};

const view = {
  viewer: "me",
  turnOrder: ["me"],
  players: {
    me: {
      name: "Georgie",
      battlefield: {
        other: [],
        creatures: [],
        enchantments: [],
        lands: [],
        artifacts: [],
      },
      command: [],
      graveyard: [],
      exile: [],
      hand: { cards: [], count: 0 },
      library: { known: [], count: 0 },
    },
  },
  stack: [],
} as unknown as PlayerView;

let root: Root;
let host: HTMLElement;
let answers: EngineAnswer[];
let closes: number;

function Harness({ prompt }: { prompt: EnginePrompt }) {
  const [pick, setPick] = useState<EnginePick>(NO_PICK);
  const [open, setOpen] = useState(true);
  if (!open) return <p className="minimised">Answer...</p>;
  return (
    <EngineListSheet
      prompt={prompt}
      view={view}
      printings={{}}
      pick={pick}
      setPick={setPick}
      answer={(a) => answers.push(a)}
      onClose={() => {
        closes++;
        setOpen(false);
      }}
      onZoom={() => {}}
    />
  );
}

function mount(prompt: EnginePrompt) {
  act(() => root.render(<Harness prompt={prompt} />));
}
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith(text),
  ) as HTMLButtonElement | undefined;
const click = (el: Element | null | undefined) =>
  act(() => (el as HTMLElement).click());

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  answers = [];
  closes = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("optional choices (Cloud's 'attach up to one target Equipment')", () => {
  it("is recognised: min 0 with options, or an optional single choice; not mulligan bottoms", () => {
    expect(isOptionalChoice(cloud)).toBe(true);
    expect(isOptionalChoice({ ...cloud, min: 1 })).toBe(false);
    expect(isOptionalChoice({ ...cloud, options: [] })).toBe(false);
    expect(
      isOptionalChoice({
        kind: "chooseMany",
        promptId: 1,
        title: "x",
        min: 0,
        max: 2,
        source: null,
        options: cloud.options,
        reason: "mulligan",
      }),
    ).toBe(false);
    expect(
      isOptionalChoice({
        kind: "choose",
        promptId: 1,
        title: "x",
        optional: true,
        source: null,
        options: cloud.options,
      }),
    ).toBe(true);
  });

  it("the primary button cannot send an empty answer and names the choice once made", () => {
    mount(cloud);
    const primary = q(".optional-confirm") as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    expect(primary.textContent).toBe("Choose a target");
    click(primary);
    expect(answers).toEqual([]);
    // the only option is first and highlighted, but not preselected
    expect(q(".choice-row.is-only")).not.toBeNull();
    expect(q(".choice-row.is-selected")).toBeNull();
    click(q(".choice-main"));
    expect(primary.disabled).toBe(false);
    expect(primary.textContent).toBe("Attach Bloodforged Battle-Axe");
    click(primary);
    expect(answers).toEqual([{ promptId: 826, options: [0] }]);
  });

  it("shows the source and what it does", () => {
    mount(cloud);
    expect(q(".optional-source")?.textContent).toBe(
      "Cloud, Ex-SOLDIER: When Cloud enters, attach up to one target Equipment you control to it.",
    );
  });

  it("closing the sheet (x, tap outside, Escape) never answers: it only minimises", () => {
    const fresh = () => {
      act(() => root.unmount());
      root = createRoot(host);
      mount(cloud);
    };
    mount(cloud);
    click(q(".sheet-close"));
    expect(q(".minimised")).not.toBeNull();
    fresh();
    click(q(".sheet-backdrop"));
    expect(q(".minimised")).not.toBeNull();
    fresh();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(q(".minimised")).not.toBeNull();
    expect(closes).toBe(3);
    expect(answers).toEqual([]);
  });

  it("choosing none is secondary and asks once before sending options: []", () => {
    mount(cloud);
    click(button("Choose none"));
    expect(answers).toEqual([]);
    expect(q(".optional-none-confirm")?.textContent).toContain(
      "Attach nothing to Cloud?",
    );
    click(button("Back"));
    expect(q(".optional-none-confirm")).toBeNull();
    click(button("Choose none"));
    click(q(".optional-none-yes"));
    expect(answers).toEqual([{ promptId: 826, options: [] }]);
  });

  it("pure helpers", () => {
    expect(canConfirm(cloud, [])).toBe(false);
    expect(canConfirm(cloud, [0])).toBe(true);
    expect(noneAnswer(cloud)).toEqual({ promptId: 826, options: [] });
    expect(
      noneQuestion({ ...cloud, ability: "Exile up to one target creature." }),
    ).toBe("Choose no target for Cloud?");
    expect(
      choiceLabel(cloud, [0], (o) => (o.kind === "card" ? o.name : "?")),
    ).toBe("Choose Bloodforged Battle-Axe");
  });
});
