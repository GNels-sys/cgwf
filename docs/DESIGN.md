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
