import type { EngineOption, EnginePrompt } from "@cgwf/shared";

/**
 * Optional choices on engine tables ("attach up to one target Equipment", "any number of", "you may
 * choose"). Owner report 2026-10-20: Cloud, Ex-SOLDIER never got his Equipment because the obvious
 * Confirm button sent an empty answer. Rules here: such a prompt always opens its list; the primary
 * button needs a selection and names it; choosing nothing is a separate, secondary button with one
 * confirmation; closing the sheet never answers.
 */

type ListPrompt = Extract<
  EnginePrompt,
  { kind: "targets" | "chooseMany" | "choose" }
>;

/** Prompts with their own modal (mulligan bottom, Draw 10 put back) are not list choices. */
const OWN_MODAL = new Set(["mulligan", "putBack"]);

export function isOptionalChoice(p: EnginePrompt | null | undefined): boolean {
  if (!p) return false;
  if (p.kind === "targets") return p.min === 0 && p.options.length > 0;
  if (p.kind === "chooseMany")
    return (
      p.min === 0 && p.options.length > 0 && !OWN_MODAL.has(p.reason ?? "")
    );
  if (p.kind === "choose") return p.optional && p.options.length > 0;
  return false;
}

/** "Cloud, Ex-SOLDIER" -> "Cloud". */
export function shortName(name: string): string {
  return name.split(",")[0]!.trim();
}

/** The secondary button: never the obvious one. */
export function noneLabel(p: ListPrompt): string {
  return p.kind === "choose" ? "Don't use this" : "Choose none";
}

/** The one confirmation before an empty answer goes out. */
export function noneQuestion(p: ListPrompt): string {
  const source = p.source ? shortName(p.source) : null;
  const text = p.kind === "targets" ? p.ability : "";
  if (source && /\battach\b/i.test(text)) return `Attach nothing to ${source}?`;
  if (p.kind === "targets")
    return source ? `Choose no target for ${source}?` : "Choose no target?";
  if (p.kind === "choose")
    return source ? `Don't use ${source}?` : "Don't use this?";
  return source ? `Choose none for ${source}?` : "Choose none?";
}

/** The primary button names what it does; with nothing picked it says what to do and stays disabled. */
export function choiceLabel(
  p: ListPrompt,
  picked: number[],
  nameOf: (o: EngineOption) => string,
): string {
  const names = picked
    .map((i) => p.options.find((o) => o.index === i))
    .filter((o): o is EngineOption => Boolean(o))
    .map(nameOf);
  if (names.length === 0)
    return p.kind === "targets" ? "Choose a target" : "Choose";
  if (names.length === 1) return `Choose ${names[0]}`;
  if (names.length === 2) return `Choose ${names[0]} and ${names[1]}`;
  return `Choose these ${names.length}`;
}

/** Whether the primary button may answer: optional prompts need at least one pick (the empty answer has its own button). */
export function canConfirm(p: ListPrompt, picked: number[]): boolean {
  if (p.kind === "choose") return picked.length === 1;
  const min = isOptionalChoice(p) ? 1 : p.min;
  return picked.length >= min && picked.length <= p.max;
}

/** The answer "choose none" sends (only after its confirmation). */
export function noneAnswer(
  p: ListPrompt,
):
  { promptId: number; options: number[] } | { promptId: number; option: null } {
  return p.kind === "choose"
    ? { promptId: p.promptId, option: null }
    : { promptId: p.promptId, options: [] };
}
