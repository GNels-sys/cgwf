# CGwF design brief (second pass: design and cleanliness)

You are refining the look and feel of CGwF ("Card Games with Friends"), a private, installable web app where four friends play Commander (a Magic: The Gathering format) on a synced virtual table. A first design pass already shipped the "arcane game-room" look; its system is documented in `docs/DESIGN.md`. Since then a lot of new UI landed quickly (a rules-engine table with overlays, local-store panels, an admin page). Your job in this pass is **consistency, clarity and polish**: make every screen feel like the same well-lit game night, remove visual clutter, tighten spacing and hierarchy, and make the rules-engine table calm and readable on a phone. Functionality must not change.

## Where it lives

- Repository: `C:\Openclaw\cgwf` (git, branch `main`). Node 24, npm workspaces: `shared/`, `server/`, `client/`. A separate Java service lives in `engine/`; you never touch it.
- Read `CLAUDE.md` first (architecture, rules, conventions), then `docs/DESIGN.md` (the current design system), then `README.md`, `docs/FORGE-ENGINE.md` (what the engine table shows and why), and `side-session-notes/`.
- Set up: `npm install`, then `npm run build -w shared` (always rebuild `shared` after pulling; a stale build makes the engine relay tests fail locally even though CI is green), then `npm run dev` (API on :8080, client on :5173 with proxy). Tests: `npm test`. Types: `npm run typecheck`. Production build: `npm run build`.
- Engine tables need the Java engine running; you do not need it for styling. The table overlays can be exercised locally through the dev bot harness described in `CLAUDE.md`, or reviewed on the live site.
- The app is live at https://cgwf.fly.dev. Do **not** deploy; see "Process" below.

## What you may change (the design surface)

All under `client/`:

- `client/src/styles.css`: global theme tokens (`--bg`, `--bg-elev`, `--fg`, `--accent`, `--border`, `--radius`, `--mana-*` ...), base typography, light/dark variants. Extend the existing system; do not start a second one.
- Stylesheets: `client/src/pages.css`, `client/src/game.css` (now the largest file, worth consolidating), `client/src/stats.css`, `client/src/admin.css`.
- Markup and class names (presentation only) in:
  - Pages: `client/src/pages/*.tsx`, including `WelcomePage`, `DecksPage`, `DeckPage`, `ImportPage`, `SearchPage`, `PlayPage`, `RoomPage`, `FriendsPage`, `ProfilePage`, `SettingsPage`, `AccountPages`, `StoresPage` (local stores list), the owner-only `AdminPage`, `LibraryPage`, `LibraryDeckPage` and `AgentsPage`.
  - Components: `client/src/components/*.tsx`, including `CardDetail`, `LocalStores` (the "Available in Las Vegas" and deck shopping panels with purchase links), `BracketPanel`, `StatsPanel`, `Header`, `Bell`, `Tour`, `PageHeading`.
  - The table, `client/src/game/*.tsx`: classic table (`Table`, `Battlefield`, `CardTile`, `Panels`, `Sheets`, `Lobby`, `LifeWidget`, `Mana`, `Triggers`, `TokenFinder`, `CardZoom`, `AgentsPanel`, `SettingsPanel`, `CombatBar`, `DamageSheet`, `PhaseStrip`) and the rules-engine overlays: `StackPanel` (top-right stack and the gold-framed "Interaction Stack"), `Overlays` (the left "Active Board" and right "Game Log" panels, their arrow tabs and the frosted toasts), `Notices` (cards and values the engine reveals to a player), `StopsPanel` (per-step stop toggles, auto-pass, hold priority), `EnginePrompts` (confirm, targets, choose, order, number, mode, mulligan, "Pay with" mana sheets).
- `client/public/`: icons, favicon, imagery under `client/public/art/`. `client/index.html` (meta, theme colour, fonts) and the PWA manifest colours/icons in `client/vite.config.ts`.
- Presets for table theme / playmat / sleeve: restyle existing ones and add new ones. Keys and labels live in `shared/src/settings.ts` (lists) and `client/src/game/look.ts` (labels/CSS mapping); add new presets in both places and keep existing keys working so saved user settings do not break.
- Motion: CSS transitions and keyframes are welcome. Keep it cheap and never blocking: no animation may delay or hide an action or a prompt. Everything must respect `prefers-reduced-motion` (`prefersReducedMotion()` in `client/src/settings.tsx`). If you believe a JavaScript animation library is needed, stop and propose it first.

## What you must not touch

- `shared/src/game/**`, `server/**`, `engine/**`, database migrations, `Dockerfile`, `fly.toml`, `engine/fly.toml`, `.github/`.
- Client logic files: `client/src/api.ts`, `client/src/user.tsx`, `client/src/settings.tsx` (logic), `client/src/game/model.ts`, `client/src/game/socket.ts`, `client/src/game/actions.ts`, `client/src/game/Engine.tsx` (engine adapter), `client/src/game/sidePanels.ts` (which side panels may be open together), `client/src/game/layoutCheck.ts` and `client/src/components/deckMetrics.ts`, `storeText.ts`. Styling may wrap them; behaviour may not change.
- The engine table's rules of the screen, which came from the owner's play-tests: the Stack panel is top-right; the Interaction Stack is a centred gold-framed window that appears only when a response is cast; the Active Board is a frosted overlay on the LEFT edge that auto-opens on turn change and leaves the player's own hand visible; the Game Log occupies the RIGHT third with tappable card names; when minimised, both collapse to arrow tabs on their screen edges and the log's toasts appear top-right, at most 2-3 at a time for about 5 seconds; at phone landscape the two side panels are not both open by default; the phase strip and pass controls are always reachable; the round label reads "Round N · <player>'s turn" with "Game turn T" small underneath. You may restyle all of these freely; do not move them, merge them or change when they appear.
- `layoutCheck` must keep returning no problems at 812x375 and 375x812 with each overlay open and closed, including after rotating; the tests in `client/src/game/layoutCheck.test.ts` and `overlays.test.tsx` enforce it.
- `client/src/components/Footer.tsx`: the Fan Content Policy notice and the Scryfall credit are legally required on every page. Restyle, never shorten or hide.
- `client/src/components/CardImage.tsx` behaviour: card images are shown whole at the real card ratio (63:88), never cropped, filtered, recoloured, darkened or overlaid in a way that hides the artist line or copyright. Rounded corners, shadows and a frame are fine.
- `client/src/components/ManaCost.tsx` approach: mana symbols are plain coloured dots by the owner's decision. Refine them through the `--mana-*` tokens; no symbol artwork.
- Local stores: CGwF only links out and never sells. Keep store and purchase links clearly labelled as links to other sites, and keep the "updated X ago, from local store data" note visible.
- Licensing (non-negotiable): no Wizards of the Coast logos, trademarks, mana symbols, set symbols or card art anywhere in the UI or assets. No fonts or marks that imitate the official brand. New imagery must be original, generated by you, or clearly CC0/public domain; record every asset's source in `docs/DESIGN.md`.

## Design direction for this pass

- One system everywhere: the same tokens, type scale, spacing rhythm, button styles, panel ("glass") treatment and empty/loading/error states on every page. Find and remove one-off colours, sizes and shadows that crept in; prefer tokens.
- The engine table is the priority. A Commander game on a phone in landscape must stay readable with the Stack, a prompt sheet, a toast and an open side panel at the same time: clear z-order, consistent frosted surfaces, one accent colour for "your decision is needed", and nothing covering the player's hand unless the player opened it.
- Hierarchy: the player's own battlefield and hand are the hero; opponents are glanceable; life, mana, the stack and prompts readable at arm's length.
- Devices, in priority order: phone landscape (812x375), phone portrait (375x812), desktop. Touch targets at least 44px. WCAG AA contrast in dark and light mode.
- Keep the first-run promise: a new player can start with a name and avatar in ten seconds.

## Process

1. Create a branch from the latest `main`: `git fetch origin && git checkout -b design-pass-2 origin/main`. Commit in meaningful steps with clear messages.
2. Before every commit: `npm run typecheck` and `npm test` must pass and `npm run build` must succeed. There are 273 tests; they are the safety net, do not edit them to make them pass.
3. Verify visually at the three sizes, in dark and light mode, with reduced motion on, and on an engine table with the Stack, Interaction Stack, a prompt sheet, toasts and each side panel open and closed. Include screenshots in your report.
4. Update `docs/DESIGN.md`: tokens, type scale, spacing, components, motion rules, asset sources, and a short "what changed in pass 2".
5. Push the branch and stop. Do **not** run `fly deploy` and do not merge to `main`; the owner reviews and deploys. Never commit `.env`, anything from `C:\Openclaw\cgwf-secrets`, or files under `data/`.
6. If something in this brief conflicts with what you find in the code, stop and ask rather than guessing.
