// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopBanner, LoopOfferDialog, loopPausedText, loopSeenText } from "./LoopPrompt";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OFFER = { steps: 3, seen: 2, max: 500, key: "1a2b", titles: ["Order your triggered abilities", "Choose targets for Enduring Tenacity", "Pay 1 life?"] };

/** "Run the loop" (owner, 2026-11-21): the pop-up and the banner. */
describe("the loop pop-up", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;

  it("says what was spotted, lists the questions and runs it until it ends", () => {
    const runs: number[] = [];
    let later = 0;
    act(() => root.render(<LoopOfferDialog offer={OFFER} onRun={(n) => runs.push(n)} onLater={() => later++} />));
    expect(host.querySelector("[role=alertdialog]")).not.toBeNull();
    expect(host.textContent).toContain("This looks like a loop");
    expect(host.textContent).toContain("You answered the same 3 questions the same way twice in a row.");
    expect([...host.querySelectorAll(".loop-steps li")].map((li) => li.textContent)).toEqual(OFFER.titles);
    act(() => button("Run it until it ends").click());
    expect(runs).toEqual([500]);
    expect(later).toBe(0);
  });

  it("runs a typed number of rounds, clamped to the engine's cap, and can be put aside", () => {
    const runs: number[] = [];
    let later = 0;
    act(() => root.render(<LoopOfferDialog offer={OFFER} onRun={(n) => runs.push(n)} onLater={() => later++} />));
    const input = host.querySelector<HTMLInputElement>("input[type=number]")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const type = (v: string) =>
      act(() => {
        setter.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const submit = () => act(() => void host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    type("25");
    submit();
    type("9999");
    submit();
    type("0");
    expect(host.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(true);
    submit();
    expect(runs).toEqual([25, 500]);
    act(() => button("Not now").click());
    expect(later).toBe(1);
    expect(runs).toEqual([25, 500]);
  });

  it("words one question and longer runs", () => {
    expect(loopSeenText({ ...OFFER, steps: 1, seen: 3 })).toBe("You answered the same question the same way 3 times in a row.");
    expect(loopPausedText({ reason: "Blair is no longer a choice", done: 4, left: 496 })).toBe("Blair is no longer a choice. Answer this one and the loop carries on with your new answer.");
  });

  it("shows a put-aside offer as a banner that reopens it", () => {
    let opened = 0;
    act(() => root.render(<LoopBanner offer={OFFER} pause={null} stopping={false} onOpen={() => opened++} onStop={() => {}} />));
    expect(host.textContent).toContain("Loop found.");
    act(() => button("Run it...").click());
    expect(opened).toBe(1);
  });

  it("shows a paused loop with why, how many rounds are left, and a way to stop it", () => {
    const stops: boolean[] = [];
    const pause = { reason: "Blair is no longer a choice", done: 4, left: 496 };
    act(() => root.render(<LoopBanner offer={null} pause={pause} stopping={false} onOpen={() => {}} onStop={(s) => stops.push(s)} />));
    expect(host.textContent).toContain("Loop paused.");
    expect(host.textContent).toContain("Blair is no longer a choice.");
    expect(host.textContent).toContain("496 rounds left.");
    act(() => button("Stop the loop").click());
    expect(stops).toEqual([true]);
    act(() => root.render(<LoopBanner offer={null} pause={pause} stopping={true} onOpen={() => {}} onStop={(s) => stops.push(s)} />));
    expect(host.textContent).toContain("The loop ends with this answer.");
    act(() => button("Keep the loop").click());
    expect(stops).toEqual([true, false]);
  });

  it("shows nothing without an offer or a pause", () => {
    act(() => root.render(<LoopBanner offer={null} pause={null} stopping={false} onOpen={() => {}} onStop={() => {}} />));
    expect(host.innerHTML).toBe("");
  });
});
