import { useEffect, useMemo, useState } from "react";
import type {
  EngineAnswer,
  EngineOption,
  EnginePrompt,
  PlayerView,
  RoomMember,
  ViewCard,
} from "@cgwf/shared";
import { Avatar } from "../components/Avatar";
import { CardImage } from "../components/CardImage";
import { ManaCost } from "../components/ManaCost";
import { CardTile } from "./CardTile";
import type { EnginePick } from "./Engine";
import { describeOption } from "./EnginePrompts";
import {
  actionVerb,
  countLine,
  groupOptions,
  joinChoices,
} from "./choiceGroups";
import { allVisibleCards, findCard, type Printings } from "./model";
import {
  canConfirm,
  isOptionalChoice,
  noneAnswer,
  noneLabel,
  noneQuestion,
} from "./optionalChoice";
import { printingAsCard } from "./Overlays";

type ListPrompt = Extract<
  EnginePrompt,
  { kind: "targets" | "chooseMany" | "choose" }
>;

function toggle(list: number[], i: number, max: number): number[] {
  if (list.includes(i)) return list.filter((x) => x !== i);
  if (max === 1) return [i];
  return list.length >= max ? list : [...list, i];
}

/** The primary button's words: the verb of the effect and what is picked ("Exile Rhystic Study and Sol Ring"). */
export function primaryLabel(
  p: ListPrompt,
  picked: number[],
  nameOf: (o: EngineOption) => string,
): string {
  const names = picked
    .map((i) => p.options.find((o) => o.index === i))
    .filter((o): o is EngineOption => Boolean(o))
    .map(nameOf);
  if (names.length === 0) {
    if (p.kind === "targets")
      return p.max === 1 ? "Choose a target" : "Choose targets";
    return "Choose";
  }
  return `${actionVerb(p)} ${joinChoices(names)}`;
}

/** Oracle text of an option's card (its printing, as sent by the relay for this prompt). */
function oracleText(
  o: Extract<EngineOption, { kind: "card" }>,
  printings: Printings,
  onTable: ViewCard | null,
): string {
  const pr = o.printingId ? printings[o.printingId] : undefined;
  if (!pr) return "";
  const face = onTable ? (pr.faces[onTable.face] ?? pr.faces[0]) : pr.faces[0];
  return face?.oracleText || pr.oracleText || "";
}

function CardRow({
  o,
  view,
  printings,
  selected,
  only,
  onPick,
  onZoom,
  attachedNames,
}: {
  o: Extract<EngineOption, { kind: "card" }>;
  view: PlayerView;
  printings: Printings;
  selected: boolean;
  only: boolean;
  onPick: () => void;
  onZoom: (c: ViewCard) => void;
  attachedNames: string[];
}) {
  const [reading, setReading] = useState(false);
  const onTable = findCard(view, o.iid);
  const pr = o.printingId ? printings[o.printingId] : undefined;
  const zoomCard = onTable ?? (pr ? printingAsCard(pr, o.owner ?? "") : null);
  const power = onTable?.engine?.power ?? o.power;
  const toughness = onTable?.engine?.toughness ?? o.toughness;
  const counters = Object.entries(onTable?.counters ?? {}).filter(
    ([, n]) => n > 0,
  );
  const text = oracleText(o, printings, onTable);
  return (
    <li
      className={`choice-row${selected ? " is-selected" : ""}${only ? " is-only" : ""}`}
    >
      <button
        type="button"
        className="choice-thumb"
        aria-label={`Look at ${o.name}`}
        onClick={() => zoomCard && onZoom(zoomCard)}
        disabled={!zoomCard}
      >
        {onTable ? (
          <CardTile card={onTable} printings={printings} onHold={onZoom} />
        ) : o.printingId ? (
          <CardImage
            id={o.printingId}
            name={o.name}
            size="small"
            className="engine-row-img"
          />
        ) : (
          <span className="choice-thumb-blank" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="choice-main"
        aria-pressed={selected}
        onClick={onPick}
      >
        <span className="choice-name">
          {o.name}
          {pr?.manaCost ? <ManaCost cost={pr.manaCost} size={12} /> : null}
        </span>
        {pr?.typeLine && (
          <span className="choice-type small muted">{pr.typeLine}</span>
        )}
        <span className="choice-facts small">
          {power !== null &&
            power !== undefined &&
            toughness !== null &&
            toughness !== undefined && (
              <strong>{`${power}/${toughness}`}</strong>
            )}
          {o.tapped && <span>tapped</span>}
          {counters.map(([k, n]) => (
            <span key={k}>{`${n} ${k}`}</span>
          ))}
          {attachedNames.length > 0 && (
            <span>{`with ${joinChoices(attachedNames)}`}</span>
          )}
        </span>
        {selected && (
          <span className="choice-check" aria-hidden="true">
            ✓
          </span>
        )}
      </button>
      {text && (
        <button
          type="button"
          className="choice-read btn btn-small"
          aria-expanded={reading}
          onClick={() => setReading((r) => !r)}
        >
          {reading ? "Hide" : "Read"}
        </button>
      )}
      {reading && text && <p className="choice-oracle small">{text}</p>}
    </li>
  );
}

/**
 * Card / player choices grouped by player and zone (2026-10-20, owner request after #34). The table's glowing
 * cards stay a shortcut: they change the same pick state this sheet shows.
 */
export function GroupedChoiceSheet({
  prompt,
  view,
  printings,
  members,
  me,
  pick,
  setPick,
  answer,
  onClose,
  onZoom,
}: {
  prompt: ListPrompt;
  view: PlayerView;
  printings: Printings;
  members: RoomMember[];
  me: string | null;
  pick: EnginePick;
  setPick: (p: EnginePick) => void;
  answer: (a: EngineAnswer) => void;
  onClose: () => void;
  onZoom: (c: ViewCard) => void;
}) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [askNone, setAskNone] = useState(false);
  useEffect(() => {
    setFilter("");
    setCollapsed(new Set());
    setAskNone(false);
  }, [prompt.promptId]);
  // Escape is handled by EngineListSheet (which renders this one): it only minimises, never answers.
  const single = prompt.kind === "choose";
  const optional = isOptionalChoice(prompt);
  const max = single ? 1 : prompt.max;
  const min = single ? 1 : prompt.min;
  const picked = pick.kind === "select" ? pick.picked : [];
  const nameOf = (o: EngineOption) => describeOption(o, view).title;
  const needle = filter.trim().toLowerCase();
  const shownOptions = needle
    ? prompt.options.filter((o) => nameOf(o).toLowerCase().includes(needle))
    : prompt.options;
  const groups = useMemo(
    () => groupOptions(shownOptions, view, me, printings),
    [shownOptions, view, me, printings],
  );
  const attachments = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const c of allVisibleCards(view).values()) {
      if (!c.attachedTo || !c.printingId) continue;
      const name = printings[c.printingId]?.name;
      if (name) out.set(c.attachedTo, [...(out.get(c.attachedTo) ?? []), name]);
    }
    return out;
  }, [view, printings]);
  const onlyOne = optional && prompt.options.length === 1 && max === 1;
  const choose = (o: EngineOption) => {
    setAskNone(false);
    if (single) {
      onClose();
      answer({ promptId: prompt.promptId, option: o.index });
    } else setPick({ kind: "select", picked: toggle(picked, o.index, max) });
  };
  const toggleSection = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const memberOf = (id: string) => members.find((m) => m.userId === id);
  const what = prompt.kind === "targets" ? prompt.ability : null;
  const renderOption = (o: EngineOption) =>
    o.kind === "card" ? (
      <CardRow
        key={o.index}
        o={o}
        view={view}
        printings={printings}
        selected={picked.includes(o.index)}
        only={onlyOne}
        onPick={() => choose(o)}
        onZoom={onZoom}
        attachedNames={attachments.get(o.iid) ?? []}
      />
    ) : (
      <li
        key={o.index}
        className={`choice-row${picked.includes(o.index) ? " is-selected" : ""}${onlyOne ? " is-only" : ""}`}
      >
        <button
          type="button"
          className="choice-main"
          aria-pressed={picked.includes(o.index)}
          onClick={() => choose(o)}
        >
          <span className="choice-name">{nameOf(o)}</span>
          {o.kind === "player" ? (
            <span className="choice-type small muted">{`Player · ${view.players[o.player]?.life ?? o.life ?? "?"} life`}</span>
          ) : (
            describeOption(o, view).hint && (
              <span className="choice-type small muted">
                {describeOption(o, view).hint}
              </span>
            )
          )}
          {picked.includes(o.index) && (
            <span className="choice-check" aria-hidden="true">
              ✓
            </span>
          )}
        </button>
      </li>
    );
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet choice-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={prompt.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <strong>{prompt.title}</strong>
          <button className="sheet-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        {(prompt.source || what) && (
          <p className="optional-source small">
            {prompt.source && <strong>{prompt.source}</strong>}
            {prompt.source && what ? ": " : ""}
            {what}
          </p>
        )}
        {prompt.options.length > 12 && (
          <input
            className="input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name"
            aria-label="Filter options"
            style={{ marginBottom: 8 }}
          />
        )}
        <div className="choice-groups">
          {groups.players.map((g) => {
            const m = memberOf(g.player);
            const key = `p:${g.player}`;
            const closed = collapsed.has(key);
            const n =
              g.sections.reduce((a, s) => a + s.options.length, 0) +
              (g.playerOption ? 1 : 0);
            return (
              <section
                key={key}
                className={`choice-player${g.isYou ? " is-you" : ""}`}
                aria-label={g.isYou ? "You" : g.name}
              >
                <button
                  type="button"
                  className="choice-player-head"
                  aria-expanded={!closed}
                  onClick={() => toggleSection(key)}
                >
                  {m && <Avatar avatar={m.avatar} color={m.color} size={26} />}
                  <strong>{g.isYou ? `You (${g.name})` : g.name}</strong>
                  {g.life !== null && (
                    <span className="small muted">{`${g.life} life`}</span>
                  )}
                  <span className="choice-count small">{n}</span>
                  <span className="choice-chevron" aria-hidden="true">
                    {closed ? "▸" : "▾"}
                  </span>
                </button>
                {!closed && (
                  <>
                    {g.playerOption && (
                      <ul className="choice-list">
                        {renderOption(g.playerOption)}
                      </ul>
                    )}
                    {g.sections.map((s) => {
                      const skey = `${key}:${s.key}`;
                      const sclosed = collapsed.has(skey);
                      return (
                        <div key={skey} className="choice-zone">
                          <button
                            type="button"
                            className="choice-zone-head small"
                            aria-expanded={!sclosed}
                            onClick={() => toggleSection(skey)}
                          >
                            {s.label}{" "}
                            <span className="muted">{s.options.length}</span>{" "}
                            <span aria-hidden="true">
                              {sclosed ? "▸" : "▾"}
                            </span>
                          </button>
                          {!sclosed && (
                            <ul className="choice-list">
                              {s.options.map(renderOption)}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </section>
            );
          })}
          {groups.stack.length > 0 && (
            <section className="choice-player" aria-label="On the stack">
              <div className="choice-player-head is-static">
                <strong>On the stack</strong>
              </div>
              <ul className="choice-list">{groups.stack.map(renderOption)}</ul>
            </section>
          )}
          {groups.other.length > 0 && (
            <section className="choice-player" aria-label="Other">
              <div className="choice-player-head is-static">
                <strong>Other</strong>
              </div>
              <ul className="choice-list">{groups.other.map(renderOption)}</ul>
            </section>
          )}
          {shownOptions.length === 0 && (
            <p className="muted">Nothing matches.</p>
          )}
        </div>
        {askNone && optional ? (
          <div
            className="optional-none-confirm"
            role="alertdialog"
            aria-label={noneQuestion(prompt)}
          >
            <p>
              <strong>{noneQuestion(prompt)}</strong>
            </p>
            <div className="actions">
              <button className="btn" onClick={() => setAskNone(false)}>
                Back
              </button>
              <button
                className="btn btn-danger-quiet optional-none-yes"
                onClick={() => answer(noneAnswer(prompt))}
              >
                Yes, {noneLabel(prompt).toLowerCase()}
              </button>
            </div>
          </div>
        ) : (
          <div className="choice-foot">
            {!single && (
              <p className="choice-counter small muted">
                {countLine(min, max, picked.length)}
              </p>
            )}
            <div className="actions">
              {!single && (
                <button
                  className="btn btn-primary optional-confirm"
                  disabled={!canConfirm(prompt, picked)}
                  onClick={() =>
                    answer({ promptId: prompt.promptId, options: picked })
                  }
                >
                  {primaryLabel(prompt, picked, nameOf)}
                </button>
              )}
              {optional && (
                <button
                  className="btn btn-small optional-none"
                  onClick={() => setAskNone(true)}
                >
                  {noneLabel(prompt)}
                </button>
              )}
              {prompt.kind === "targets" &&
                (prompt.cancelLabel || !optional) && (
                  <button
                    className="btn btn-small"
                    onClick={() =>
                      answer({
                        promptId: prompt.promptId,
                        options: [],
                        cancel: true,
                      })
                    }
                  >
                    {prompt.cancelLabel ?? "Cancel"}
                  </button>
                )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
