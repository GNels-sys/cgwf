# CGwF design refresh

## Direction and scope

An intimate arcane game room: forest and ink surfaces, brass edges, parchment light mode,
literary serif headings, felt and wood, and original atmospheric fantasy artwork. The CGwF
name and the existing quick name/avatar onboarding stay. This is a presentation change;
no API, game events, reducers, permissions, or socket behavior changed.

The owner explicitly chose to preserve the current full-screen gameplay layout on
2026-10-16, including its existing treatment of site chrome and table notice. The full
Footer component and all its wording are unchanged. The owner also permitted official
artwork; this implementation adds original generated artwork and retains the existing
Scryfall card-image pipeline.

## Foundations

| Token | Dark | Light |
| --- | --- | --- |
| `--bg` | `#101918` | `#f3efe4` |
| `--bg-elev` | `#192523` | `#ffffff` |
| `--bg-elev-2` | `#253532` | `#e9e3d3` |
| `--fg` | `#f3eee2` | `#1e2420` |
| `--fg-muted` | `#b4c0b7` | `#526057` |
| `--border` | `#40514a` | `#d4ccb8` |
| `--brass` | `#dfb76d` | same decorative brass |
| `--radius` | `12px` | `12px` |

`--accent` remains user-selectable and SettingsProvider remains its authority (the saved
brass preset is `#d9a441`). Light-surface accent text uses `#805b21` for readable links,
life totals, and navigation. Hero copy uses ivory on an explicitly dark scrim in both
interface modes. Custom tokens keep light text on their dark token face. The primary
body foreground/background pair exceeds WCAG AA; themed surfaces use dedicated text
colors rather than applying light-mode ink to dark felt. No claim of a full-site
accessibility audit is implied.

Mana chart colors preserve W/U/B/R/G/C order and their existing tokens: `#e8dfb8`,
`#2f7fd6`, `#6b5f78`, `#d64a3a`, `#3f9a56`, `#9a9a9a` in dark mode, with existing
light overrides. Mana remains colored dots and letter/value labels, without symbol art.
The five welcome dots are decorative and hidden from assistive technology.

## Type, spacing, and controls

- Display: locally available Georgia, Times New Roman, serif. No external font request.
- Body and controls: existing system sans stack, 16px base, 1.5 line height.
- Hero: fluid 2.4–4.3rem, 1.06 line height; page titles: 1.8–2.5rem; section titles: 1.6rem.
- Eyebrows: 0.7rem, uppercase, 0.19em tracking. Supporting text: 0.78–0.95rem.
- Spacing follows an 8px rhythm: 8/16/24/32/48px, with 4px optical adjustments.
- Rounded 12px panels; 16px hero frame; thin brass/neutral borders, restrained shadows.
- Upgraded small buttons, chips, color choices, mana controls, anthem actions, and upload
  remove controls have at least 44px targets. Existing card scaling remains user-controlled.
- Keyboard focus has a visible 2px accent outline and 4px offset.

## Table and responsive behavior

The table retains its existing full-screen grid and all personalization keys. Felt has
fine cross-grain texture and soft ambient light; oak has varied grain; slate has subtle
veins; velvet has warm depth. Existing sleeve presets gain a small original geometric
frame, excluding uploaded sleeves and text tokens. No new preset keys were necessary.

The player's battlefield keeps its three-row section arrangement. The empty Other row
can collapse; populated rows retain their content height and the battlefield scrolls
when necessary. In portrait, opponents/turn controls wrap and zones, hand, and life stack.
A zero-minimum grid track prevents intrinsic card-strip widths from expanding the table
past the viewport. Opponent and hand strips scroll horizontally inside the table.

CardImage behavior is untouched: complete 63:88 images with object-fit contain. New
shadows are on image containers and card frames, never filters or artwork overlays.

## Motion

CSS only. Controls transition background, border, and shadow for 160ms. Existing tap,
flip, life-tick, and card-arrival effects remain. No action waits for an animation.
A global prefers-reduced-motion rule removes animations, transitions, and smooth scroll,
including pseudo-elements; existing game-specific reduced-motion behavior remains.

## Assets and provenance

- `client/public/art/sanctuary.jpg`: original artwork generated for this project with
  the built-in ImageGen tool on 2026-10-16. 1536×1024; JPEG quality 86; 290,279 bytes.
  The generated PNG was re-encoded for the app's existing 2 MiB offline-cache ceiling.
- Original generation prompt: "Use case: stylized-concept. Create a wide 1536x1024
  original fantasy landscape painting for a private tabletop card gaming web app.
  An ancient circular stone sanctuary high above a misty evergreen valley, distant
  monumental spires, teal twilight sky, a warm amber-lit archway on the right, a small
  original cloaked mage seen from behind at right lower third, tiny floating embers.
  Rich painterly detail, sophisticated atmospheric fantasy book illustration, emerald,
  deep navy, antique gold, warm candlelight. Left third mostly dark softly textured
  atmospheric negative space for white webpage text. No text, no logos, no card frames,
  no symbols, no existing franchise characters. Full bleed cinematic artwork."
- Brand diamond, sleeve ornament, textures, gradients, and five dots: original
  code-native CSS/text geometry authored in this refresh. No downloaded assets.
- Existing avatars, app icons, Scryfall data and images: existing sources and behavior
  unchanged. No new official character artwork, card artwork, mana symbols, or logos
  were bundled into the app shell.

## Verification and screenshots

Required checks: `npm run typecheck`, `npm test` (193 tests), and `npm run build`.
Browser QA: local Vite client, headless installed Microsoft Edge through Playwright.
API/WebSocket responses were intercepted with synthetic four-player data and custom
text tokens so browser QA did not modify the existing local database. This verifies
presentation and menu accessibility, not a new live multiplayer/network integration.
No production service was changed or deployed.

Screenshots cover 812×375 landscape, 375×812 portrait, and 1440×1000 desktop, dark and
light, reduced motion enabled. `design-previews/qa.json` records viewport bounds,
computed life colors, animation state, and JavaScript errors. At each size the table,
hand, and life controls fit within the viewport; no page errors were recorded.
Mana popovers were opened and captured at every size/theme. Normal-motion mode was
then restored and the Menu / Game log action was checked at every size/theme.
Onboarding, collection, and lobby screenshots are also retained. Table screenshots use
synthetic text tokens and do not represent a real game or imported card art.

| View | Dark | Light |
| --- | --- | --- |
| Welcome, desktop | [Preview](design-previews/welcome-desktop-dark.jpg) | [Preview](design-previews/welcome-desktop-light.jpg) |
| Welcome, landscape | [Preview](design-previews/welcome-landscape-dark.jpg) | [Preview](design-previews/welcome-landscape-light.jpg) |
| Welcome, portrait | [Preview](design-previews/welcome-portrait-dark.jpg) | [Preview](design-previews/welcome-portrait-light.jpg) |
| Table, desktop | [Preview](design-previews/table-desktop-dark.jpg) | [Preview](design-previews/table-desktop-light.jpg) |
| Table, landscape | [Preview](design-previews/table-landscape-dark.jpg) | [Preview](design-previews/table-landscape-light.jpg) |
| Table, portrait | [Preview](design-previews/table-portrait-dark.jpg) | [Preview](design-previews/table-portrait-light.jpg) |
| Onboarding, portrait | [Preview](design-previews/start-portrait-dark.jpg) | [Preview](design-previews/start-portrait-light.jpg) |

Additional screenshots in `design-previews/`: onboarding at all sizes, mana popovers
at all sizes, and collection/lobby at portrait and desktop in dark mode.

## Review and release

Review branch: `design-refresh`. The owner subsequently authorized deployment, and the
first refresh was deployed to https://cgwf.fly.dev/ on 2026-10-16. No merge into main. The referenced side-session-notes directory was absent from this checkout;
CLAUDE.md, README.md, and docs/DESIGN-BRIEF.md were read instead. The repository brief's
current test count (193) supersedes the pasted brief's older count (185).


## Interior-page follow-through (2026-10-16)

The second pass extends the game-room design throughout the app:

- `PageHeading` supplies a shared eyebrow, title, supporting description, geometric
  emblem, and optional action. Play and Personalize reuse the original sanctuary
  illustration; content-heavy pages use a quieter divider and emblem.
- Play separates hosting from joining. Friends separates invitation codes, requests,
  presence, and table links. Profiles group identity, connections, and account controls.
- Card search has a clear starting state and framed result tiles; card details retain
  complete images. Import has dedicated input/review surfaces and portrait rows that
  put board/skip controls below card text. Sticky review actions remain available.
- Deck and library editors share a workshop heading and consistent analysis/list
  surfaces. Library filters and queue actions remain complete. Statistics retain their
  labels, color order, calculations, and collapsible content.
- Personalize groups mats, sleeves, room, and layout in two columns on desktop and one
  on phones. Account forms, sessions, notifications, agent history, and the owner
  dashboard use the same form spacing, panels, and control sizes. Admin totals use four
  columns at desktop widths and two on narrow phones.
- On phones the header uses a brand/profile row followed by a scrollable navigation
  row. Personalize is directly accessible from navigation. The existing full-screen
  gameplay treatment remains in place.

No new artwork or dependency was introduced. The original ImageGen asset above is
reused. Gameplay, API, identity, socket logic, tests, server code, and shared models are
unchanged. All modifications are presentational JSX, navigation links, or CSS.

Interior QA uses representative synthetic accounts, friends, decks, library entries,
agent games, and admin totals through browser request interception. Card summaries
and complete card images use the existing local Scryfall catalogue/image pipeline.
The private preview data never wrote to the local or production database. Owner-only
routes were rendered with an intercepted owner session, not production credentials.

The matrix covers 16 page views at 375×812, 812×375, and 1440×1000 in dark/light
interfaces with reduced motion, plus import-review states at each size. Supplemental
checks cover empty friends/play/library/agent pages, a failed friends request, and
notifications with normal motion. Card-result and card-detail overlays were captured;
deck rename/cancel, password-form opening, and admin-row expansion were exercised.
The existing table, lobby, and mana-popover matrix was also repeated. This remains
browser emulation, not a physical iOS/Android device test or live multiplayer test.

A compact selection of current screenshots is retained in
[interior previews](design-previews/interiors/); `qa.json` there records the full
interior matrix. Additional local captures are available at
`C:/Users/nelso/OneDrive/Documents/Playground/output/cgwf-interior/`.

| Page | Preview |
| --- | --- |
| Play | [Desktop](design-previews/interiors/play-desktop-dark.jpg) |
| Friends | [Phone](design-previews/interiors/friends-portrait-dark.jpg) |
| Personalize | [Desktop](design-previews/interiors/settings-desktop-dark.jpg) |
| Profile | [Phone](design-previews/interiors/profile-portrait-dark.jpg) |
| Sign in | [Light desktop](design-previews/interiors/signin-desktop-light.jpg) |
| Card search | [Results](design-previews/interiors/card-results-desktop-dark.jpg) |
| Import | [Phone review](design-previews/interiors/import-review-portrait-dark.jpg) |
| Deck | [Desktop](design-previews/interiors/deck-desktop-dark.jpg) |
| Library | [Light desktop](design-previews/interiors/library-desktop-light.jpg) |
| Library editor | [Desktop](design-previews/interiors/library-deck-desktop-dark.jpg) |
| Computer opponents | [Desktop](design-previews/interiors/agents-desktop-dark.jpg) |
| Admin | [Desktop](design-previews/interiors/admin-desktop-dark.jpg) |


## Illustrated glass and gameplay motion (2026-10-16)

### Artwork and frosted surfaces

`client/public/art/realms.jpg` is a new original environment painting made with the
built-in ImageGen tool: woodland, moonlit observatory ruins, and an ember sanctuary.
It is 1536×1024, JPEG quality 86, 351,986 bytes. Different portions of this image
appear behind deck tiles, interior headers, library rows, friend invitations, and
host/join panels. The image and glaze are separate background pseudo-elements;
complete card faces, names, artist lines, and copyright stay sharp and unobscured.

Generation prompt: "Use case: stylized-concept. Asset type: original fantasy environment
illustration for subtle website panel backgrounds. A panoramic painterly triptych with
three equal vertical regions seamlessly flowing into each other, no visible frame or
text: left an emerald ancient woodland with luminous fireflies and immense mossy roots,
center a teal moonlit ruined observatory above mist with distant spires and crystalline
pools, right a warm ember volcanic mountain sanctuary with copper light and floating
ash. Rich sophisticated hand-painted fantasy world concept art. Atmospheric, low visual
clutter, no characters, no lettering, no logos, no existing franchise designs. Wide
1536x1024 composition. These scenes will become subdued frosted backgrounds behind UI
text; keep broad soft masses, beautiful depths and restrained luminous accents."

Glass tokens: `--glass` is `#172722b3` in dark mode and `#fffdf1c7` in light mode;
`--glass-strong` gives number/confirmation dialogs a denser fill. Dedicated
`--glass-muted` colors keep supporting text readable. Menus, action sheets, card
modals, mana panels, notifications, triggers, and mulligan panels use 18px backdrop
blur and subtle warm edges. Backdrops lightly dim the table instead of blacking it
out. Browsers without backdrop-filter keep the original opaque surface fallback.
The artwork is compressed; `.jpg` shell art is now included in the PWA precache
alongside the existing assets (17 entries, about 1.25 MiB total).

### Motion behavior

`useTableMotion.ts` is a presentation-only hook using native Web Animations. No library
or dependency was added, and no action, event, reducer, socket, or game rule changed.
Data attributes on existing tiles/zones provide geometry. The hook compares authorized
per-player views after React renders the new state and draws noninteractive ghosts:

- Library to hand: 360ms sleeve arc; the real card is already present and actionable.
- Hand/command zone to battlefield: a short physical card trail and arrival outline.
- Visible card to graveyard: 460ms departure with a restrained ember edge. This is a
  zone-move treatment, not a rules-engine assertion that a card was destroyed; discard
  and sacrifice use the same graveyard treatment.
- Exile: a quiet violet edge; return to hand: a soft blue edge. Library-to-graveyard or
  exile moves can use a sleeve trail when the source was not previously visible.
- Existing tap/untap rotation, flips, life ticks, and trigger highlights remain. New
  token/card arrivals use an outline instead of fading an actionable tile out. Menus
  settle by 8px over 150ms, with no hidden or delayed actions.

Trails are capped at six per update and removed on completion, the next update, or
unmount. They have `aria-hidden` and `pointer-events: none`. Initial load, disconnected
state, background tabs, large event jumps, and rewinds skip travel. Rewinds are detected
from log history as well as sequence numbers, because a silent undo can increase the
wire sequence while shortening the public log. There is no trail if native animation
support is unavailable. The live reduced-motion media query cancels in-flight native
animations immediately; CSS motion is also disabled.

Hidden-information boundaries remain intact: drawing uses a sleeve; no hidden card
identity is requested or inferred. A departing face may reuse only an image already
on the current viewer's screen. Moves into libraries always use a sleeve. Opponents'
hidden hands are never enumerated or exposed by the effect.

### Verification

All 193 tests, type checking, and production build pass. The 138-check interior matrix
was repeated with no JavaScript errors or page overflow. Dynamic browser checks at
375×812, 812×375, and 1440×1000, in both themes, exercised drawing, playing,
graveyard/exile moves, returning to hand, immediate input availability, cleanup,
reduced motion, switching reduced motion on mid-animation, and silent-undo suppression.
The motion checks used synthetic synchronized views and did not write to any database.
These remain browser-emulated checks rather than physical-phone or live multiplayer
testing. Gameplay timing and multi-card effects are decorative and deliberately brief.

Current examples are retained in `design-previews/glass/`:
[Decks](design-previews/glass/decks-desktop-dark.jpg),
[Phone decks](design-previews/glass/decks-portrait-dark.jpg),
[Frosted table menu](design-previews/glass/frosted-menu-landscape-dark.jpg),
[Light table menu](design-previews/glass/frosted-menu-landscape-light.jpg), and
[Draw in progress](design-previews/glass/drawing-landscape-dark.jpg).
`qa-motion.json` records the dynamic checks and computed glass styles for the menu,
action sheet, and mana panel in all six size/theme combinations. The glass selector
has enough specificity to retain translucency after game-specific surface rules.


## Consistent deck sizes and connected scenery (2026-10-16)

Deck tiles now use equal-height grid rows, consistent 63:88 artwork frames, and
wrapping text. Single commanders, partners, and missing commanders occupy the same
outer frame. Partner images scale side by side inside that frame without cropping;
long names remain fully readable. The grid stretches every tile to the same height
across all rows at a given viewport width.

`deckScenery.ts` maps the deck ID to woodland, moon, or ember scenery with a stable
hash. The collection tile and deck-detail route use the same mapping, including
direct links and reloads; positional nth-child presets were removed. Opening a deck
carries that pane's artwork and scene position into the full-page canvas. The deck
collection also uses the existing sanctuary banner image as its page backdrop.
Scenery is painted on the body via the existing CSS :has approach so it cannot
obscure navigation, content, or fixed dialogs. No game, API, or saved-setting behavior
changes are involved.

The Cards results area has a new Eldrazi-inspired alien-plane painting, with a
matching cool-toned header. Card-result panels and starting states remain readable
on glass surfaces. Complete card images keep their original aspect ratio and colors.

New original asset: `client/public/art/alien-plane.jpg`, generated using the built-in
ImageGen tool, 1536×1024, JPEG quality 86, 276,769 bytes. It is included by the existing
JPG shell-art precache rule. Prompt: "Use case: stylized-concept. Asset type: wide
original background painting for a fantasy card catalogue. An uncanny Eldrazi-inspired
alien plane, with immense floating fractured stone rings and angular monoliths above
a desolate lavender-gray landscape, twisting pale organic spires, impossible gravity,
distant amorphous cosmic silhouettes partly obscured by silver mist. Cold indigo,
muted lilac, bone ivory and subtle teal illumination. Elegant high-detail fantasy
environment illustration, atmospheric and spacious rather than busy or gruesome.
No text, logos, mana symbols, card borders, or copied card artwork. Keep the center
gently lit with low contrast so a grid of whole card images and frosted controls can
be readable over it. Landscape 1536x1024."

Verification: type checking, all 193 tests, and production build pass. The first test
run encountered a timing failure in the existing agent-game test while browser QA
ran concurrently; the full suite passed when rerun separately, without test edits.
Browser checks cover all three target sizes in dark/light mode, mixed commander
counts, a long name, equal tile/frame geometry, actual tile-to-detail navigation,
matching scenery, reload persistence, navigation visibility, and card search/detail.
The screenshots use intercepted demo accounts/decks and the existing local card
catalogue; no database writes occurred. Reduced-motion browser settings remained on.

Screenshots and the measured geometry are in `design-previews/deck-scenes/`:
[Desktop collection](design-previews/deck-scenes/decks-desktop-dark.jpg),
[Phone collection](design-previews/deck-scenes/decks-portrait-dark.jpg),
[Selected deck](design-previews/deck-scenes/selected-deck-desktop-dark.jpg), and
[Alien-plane card results](design-previews/deck-scenes/card-results-desktop-dark.jpg).
