# Reading cards on this table (effects primer)

## Card lines in the state

Every card is shown as `<id> Name {mana cost} [type line] P/T` followed by flags and a trimmed
oracle text. The `<id>` (for example `c42`) is what every tool takes. Your own hand and your own
permanents show their full rules text; opponents' permanents show the start of theirs.

- `{1}{G}` is the mana cost: generic numbers can be paid with any colour, letters need that colour
  ({W} white, {U} blue, {B} black, {R} red, {G} green, {C} colourless only). `{X}` is a number you
  choose when you cast it. `(tapped)` means the card is tapped. `+1/+1 x2` means two +1/+1
  counters. `attached to c12` means an Aura or Equipment is on that card.
- Lands tap for the mana named on them. Basic lands: Plains {W}, Island {U}, Swamp {B}, Mountain
  {R}, Forest {G}. A two-colour land taps for either colour, once.
- Mana rocks ("{T}: Add {C}{C}") are artifacts that tap for mana the turn they enter.

## Keywords you will see (short forms)

- **Flying**: can be blocked only by flying or reach. **Trample**: excess damage goes to the player.
  **Haste**: may attack and tap the turn it arrives. **Vigilance**: attacking does not tap it.
  **Deathtouch**: any damage it deals to a creature kills it. **Lifelink**: damage it deals also
  gains you that much life. **First strike / double strike**: deals combat damage first (double:
  twice). **Menace**: needs two blockers. **Hexproof**: opponents cannot target it. **Indestructible**:
  "destroy" and lethal damage do not kill it. **Flash**: can be cast on anyone's turn (you will
  mostly cast on your own turn anyway). **Ward {n}**: opponents' spells targeting it cost {n} more.
- **Equip {n}**: pay {n} on your main phase to attach Equipment to a creature you control
  (`attach`). **Enchant creature** (Auras) attach when cast (`cast_permanent` then `attach`).
- **Landfall**: triggers whenever a land enters under your control. **ETB** ("When X enters"):
  triggers once when it enters. **Dies**: when it goes from the battlefield to a graveyard.

## The stack-less simplification

Real Magic resolves spells on a stack with priority passing. This table has NO stack: a spell
you cast is treated as resolved immediately. That means:

- Instants are mostly cast on your own turn here; you cannot interrupt a human's spell. If you
  hold a counterspell, the only realistic use is to say so in a note and let the humans decide to
  pause for you. Do not rely on it.
- Apply a spell's effect yourself with the bookkeeping tools in the same batch of calls, then the
  spell itself goes to the graveyard (`cast_spell` does that part).
- A board wipe means moving every creature it would destroy to the graveyard, including yours.
- Triggered abilities are advisory notes; you apply them.

## Combat as the table tracks it

- Attackers are tapped and announced. Defenders choose blockers by tapping/moving nothing in
  particular; the humans will tell the table (in life changes) what happened. When a computer
  player is attacked, the attacker applies the damage as if unblocked.
- Combat damage to a creature is not tracked as a number: if a creature took lethal damage, move
  it to the graveyard. Damage wears off at end of turn.
- Commander damage: when your commander deals combat damage to a player, also call
  `commander_damage` so the 21-damage rule is tracked.

## Power and toughness on the table

The table adds the bonuses it knows about: +1/+1 counters, equipment and aura bonuses that were
confirmed, and static anthems ("creatures you control get +1/+1"). Conditional bonuses ("+1/+1
for each...") are NOT computed; reason about them yourself from the rules text.

## Mana colours and colour identity

Your deck only contains cards within your commander's colours, so colour requirements are
usually satisfiable; still count the coloured symbols against the lands you tap. If you cannot
pay the exact colours, do not cast the spell this turn.
