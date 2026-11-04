// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepeatControl } from "./RepeatControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** "Repeat this cast N times" (owner, 2026-11-04): the bar's control. */
describe("the Repeat control", () => {
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

  it("names the card, starts at ten (or the last count) and sends the number typed", () => {
    const sent: number[] = [];
    act(() => root.render(<RepeatControl offer={{ option: 2, cardName: "Sprout Swarm", last: 0, max: 500 }} onGo={(n) => sent.push(n)} />));
    expect(host.textContent).toContain("Repeat Sprout Swarm");
    const input = host.querySelector<HTMLInputElement>("input[type=number]")!;
    expect(input.value).toBe("10");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "40");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(sent).toEqual([40]);
  });

  it("remembers the last run, clamps to the engine's cap and refuses fewer than two", () => {
    const sent: number[] = [];
    act(() => root.render(<RepeatControl offer={{ option: 0, cardName: "Sprout Swarm", last: 40, max: 500 }} onGo={(n) => sent.push(n)} />));
    const input = host.querySelector<HTMLInputElement>("input[type=number]")!;
    expect(input.value).toBe("40");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "9999");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(sent).toEqual([500]);
    act(() => {
      setter.call(input, "1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(true);
    act(() => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(sent).toEqual([500]);
  });
});
