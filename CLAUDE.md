# CGwF - Card Games with Friends

Private virtual card table for four friends (think SpellTable, not Arena). Players enforce the
rules themselves in v1; the architecture must leave room for a rules engine later.
The owner is a non-developer directing the build: explain decisions briefly, prefer boring tech,
keep the repo readable.

## Non-negotiables

1. **Licensing.** Unofficial Fan Content under Wizards of the Coast's Fan Content Policy. Free, no
   payments, no WotC logos/trademarks in the UI or the app name. Every page shows the footer notice
   in `client/src/components/Footer.tsx` plus "Card data and images courtesy of Scryfall."
   Mana symbols are drawn as plain coloured dots (`ManaCost.tsx`), never Scryfall/WotC symbol art.
2. **Scryfall rules.** Bulk data only (`default_cards`), never per-card API calls at scale. Every
   request goes through `server/src/scryfall/client.ts` (User-Agent + Accept headers, 100 ms gap).
   Card data cached 24 h+. Images proxied and cached on the volume (`server/src/images.ts`),
   served byte-for-byte: never cropped, resized, recoloured or watermarked.
3. **Hidden information is server-enforced.** (Phase 3) The server holds the only true state; each
   client gets a per-player view that never contains identities of cards in libraries, other hands,
   or face-down cards. A test must prove this.
4. **Server-authoritative, event-sourced.** (Phase 3) Every action is an event appended to a log;
   state is a pure reducer over the log plus a stored RNG seed (seeded shuffle). Reducer and event
   types live in `/shared` so client and server never disagree.

## Locked decisions (owner, 2026-10-15)

- Name: CGwF. Open web app; a 6-character join code gates each game. Rate-limit room creation and
  deck import.
- No voice/video. Light animations only, respecting `prefers-reduced-motion`.
- **SQLite** on the Fly volume via Drizzle (not Fly Postgres): one machine, one file. Drizzle keeps
  the schema portable.
- Commander only in v1 (keep `format` in the model). Partner commanders from day one. Track
  commander tax, life, poison, commander damage, every counter type.
- Battlefield = structured rows per player (lands / creatures / other); tap an opponent to view
  their field. Phone landscape is the primary device.
- Interaction: tap-to-select + action sheet is primary; `@dnd-kit` drag is secondary.
- Stop after each phase's deploy so the owner can check it on their phone.

## Layout

```
shared/   types shared by both sides: card types, mana parser, API shapes (later: events, reducer)
server/   Fastify + better-sqlite3 + Drizzle; Scryfall ingest; image proxy; REST (later: WebSocket)
client/   React + Vite PWA (vite-plugin-pwa); plain CSS, mobile-first
```

Scripts (root): `npm run dev` (server :8080 + client :5173 with proxy), `npm test`,
`npm run typecheck`, `npm run build`, `npm run ingest` (built CLI), `npm run db:generate`.

## Conventions

- TypeScript strict everywhere, ESM (`"type": "module"`, `.js` suffixes on relative imports in
  server/shared). Node 24, npm workspaces.
- `shared` must be built (`npm run build -w shared`) before server typecheck; Vite and Vitest alias
  `@cgwf/shared` to `shared/src` so dev and tests need no build.
- Schema changes: edit `server/src/db/schema.ts`, run `npm run db:generate`, commit the SQL under
  `server/drizzle/`. The server applies migrations on boot.
- Tests are Vitest. Server API tests ingest `server/src/scryfall/fixtures/cards.sample.json` into
  a temp SQLite file and hit routes with `app.inject`.
- Files are LF. Windows editors may write CRLF; `.gitattributes` normalises on commit.
- Images: `/img/{small|normal|large}/{scryfallId}.jpg` and `/img/{size}/{id}/back.jpg`.
- Config via env (`.env.example`). Secrets only in Fly secrets, never in the repo.

## Data flow (Phase 1)

Boot -> apply migrations -> build in-memory name index -> listen. 3 s later, if card data is
older than `CARD_DATA_MAX_AGE_HOURS`, download Scryfall's `default_cards` (gzipped JSON Lines,
~80 MB) to the volume and stream it into `cards` (upsert, then prune rows not seen this run).
The machine scales to zero, so there is no cron: staleness is checked on boot and hourly while
awake. A finished download survives an interrupted import.

Search: `NameIndex` keeps one best printing per oracle id (paper > promo-free > in boosters >
hi-res scan > newest) plus aliases for each face name; tiers exact > prefix > word > substring >
bounded edit distance.

## Phases

1. Scaffold, Fly deploy, PWA shell, Scryfall ingest, card search page. **(this phase)**
2. Device identity, decks, decklist parser with per-site fixtures, printing resolution.
3. Rooms, join codes, WebSocket sync, event log + reducer, the table, hidden info, reconnect.
4. Undo/revert, token finder, log panel, personalization, light animations.
