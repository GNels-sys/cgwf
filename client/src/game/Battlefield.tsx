import { useDroppable } from "@dnd-kit/core";
import { SECTION_LABELS, describeAnthems, type DerivedBattlefield, type Section, type ViewCard, type ViewPlayer } from "@cgwf/shared";
import { CardTile } from "./CardTile";
import type { SleeveStyle } from "./look";
import { battlefieldCards, stacksOf, type Printings } from "./model";

/**
 * One player's battlefield: Other on top, then Creatures | Enchantments, then
 * Lands | Artifacts. Attachments are drawn under their host and never in the
 * Artifacts / Enchantments sections while attached. Used for my own table
 * (droppable) and inside the opponent panel (read layout, same tiles).
 */
interface Props {
  player: ViewPlayer;
  printings: Printings;
  derived: DerivedBattlefield;
  onTap: (c: ViewCard) => void;
  onHold: (c: ViewCard) => void;
  draggable?: boolean;
  droppable?: boolean;
  highlighted?: ReadonlySet<string>;
  /** Tap the anthem badge on the Creatures header. */
  onAnthems?: (() => void) | undefined;
  compact?: boolean;
  /** Sleeve (card back) for face-down cards, by owner. */
  sleeveOf?: ((ownerId: string) => SleeveStyle) | undefined;
}

function SectionView({ section, player, printings, derived, onTap, onHold, draggable, droppable, highlighted, onAnthems, sleeveOf, wide }: Props & { section: Section; wide: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `row:${section}`, disabled: !droppable });
  const all = battlefieldCards(player);
  const stacks = stacksOf(player.battlefield[section], all);
  const anthem = section === "creatures" ? describeAnthems(derived) : null;
  return (
    <div ref={setNodeRef} className={`bf-section is-${section}${wide ? " is-wide" : ""}${isOver ? " is-over" : ""}`}>
      <div className="bf-head">
        <span className="bf-label">{SECTION_LABELS[section]}</span>
        {section === "creatures" && (anthem || onAnthems) && (
          <button className={`anthem-badge${anthem ? "" : " is-empty"}`} onClick={onAnthems} title="Anthems affecting your creatures">
            {anthem ?? "anthems"}
          </button>
        )}
      </div>
      <div className="bf-cards">
        {stacks.map(({ host, attachments }) => (
          <div key={host.iid} className={`stack${attachments.length ? " has-attachments" : ""}`} style={{ "--n": attachments.length } as React.CSSProperties}>
            <CardTile card={host} printings={printings} onTap={onTap} onHold={onHold} draggable={draggable} derived={derived.cards.get(host.iid)} highlight={highlighted?.has(host.iid)} sleeve={sleeveOf?.(host.owner)} />
            {attachments.map((a, i) => (
              <div key={a.iid} className="stack-attachment" style={{ "--i": i + 1 } as React.CSSProperties}>
                <CardTile card={a} printings={printings} onTap={onTap} onHold={onHold} draggable={draggable} attached derived={derived.cards.get(a.iid)} highlight={highlighted?.has(a.iid)} sleeve={sleeveOf?.(a.owner)} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Battlefield(props: Props) {
  return (
    <div className={`bf${props.compact ? " is-compact" : ""}`}>
      <SectionView {...props} section="other" wide />
      <div className="bf-split">
        <SectionView {...props} section="creatures" wide={false} />
        <SectionView {...props} section="enchantments" wide={false} />
      </div>
      <div className="bf-split">
        <SectionView {...props} section="lands" wide={false} />
        <SectionView {...props} section="artifacts" wide={false} />
      </div>
    </div>
  );
}
