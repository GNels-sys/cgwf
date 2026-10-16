# CGwF - Card Games with Friends

A private, installable web app for playing tabletop card games with friends over the internet:
a perfectly synced virtual table with real card images. Players enforce the rules themselves.

CGwF is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by
Wizards. Portions of the materials used are property of Wizards of the Coast. (c) Wizards of the
Coast LLC. Card data and images courtesy of [Scryfall](https://scryfall.com).

## What it does

- Import Commander decks (paste a list or an Archidekt link), with real card images.
- Open a table, share a six-character code, seat up to four players plus spectators.
- Play on a synced virtual table: hands and libraries stay hidden server-side, every action is
  logged as a sentence, your own last action undoes silently, anyone can rewind from the log.
- Find tokens from the Scryfall catalogue ("treasure", "2/2 zombie") or make a text-only one.
- Personalize: playmat and card sleeves (presets or your own image, up to 2 MB, visible only to
  your table), table theme, accent, light/dark interface, optional ambient sound, card size and
  layout. Saved to your account.
- Rematch from a finished table with the same seats and decks.
- Every deck page shows a Commander Bracket panel: the lowest bracket the official rules allow
  and a suggested bracket, with the reasons card by card (Game Changers, mass land denial, extra
  turns, two-card infinite combos found by Commander Spellbook), strategy tags and a summary.
  No AI involved; the Game Changers list is a dated file you can edit by hand.
- Owner only: a deck library of every Commander precon (imported from MTGJSON) plus your own
  decks, each with a bracket, tags and a primer, for the future AI opponents to pilot.
- Start in ten seconds with just a name and an avatar; add an email and password later to use
  your decks on other devices, see which devices are signed in and sign any of them out.

## Stack

TypeScript everywhere. Server: Node 24 + Fastify + SQLite (better-sqlite3, Drizzle ORM).
Client: React + Vite, installable PWA. Deployed on Fly.io as one machine with one volume.

```
shared/   types + pure logic shared by client and server
server/   API, Scryfall ingest, image cache
client/   the PWA
```

## Run locally

```bash
npm install
npm run build -w shared
npm run dev
```

Open http://localhost:5173. The client proxies `/api` and `/img` to the server on :8080.
On first start the server downloads Scryfall's bulk card data (~80 MB) into `./data` and imports
it; the search page shows progress. Copy `.env.example` to `.env` to change settings.

Other commands:

```bash
npm test               # unit + API tests
npm run typecheck
npm run build          # production build of all three packages
npm run db:generate    # after editing server/src/db/schema.ts
npx tsx server/src/cli.ts ingest --force   # re-import card data now (dev)
```

## Deploy to Fly.io

First time only:

```bash
fly apps create cgwf
fly volumes create cgwf_data --region lax --size 10 --app cgwf
fly secrets set CONTACT_EMAIL=you@example.com --app cgwf
```

Every deploy:

```bash
fly deploy
```

The app scales to zero when idle and wakes on the first request. Card data refreshes automatically
when it is more than 24 hours old. To force a refresh on the running machine:

```bash
fly ssh console -C "node server/dist/cli.js ingest --force"
```

Optional: set `ADMIN_TOKEN` as a Fly secret to allow `POST /api/admin/ingest` with an
`x-admin-token` header from outside the machine.

Owner access: set `OWNER_CLAIM_CODE` as a Fly secret to a long random string. The person who
runs the server creates an account, opens their profile, and enters that code once under
"Owner access"; the account is then flagged as the owner (for owner-only features). Attempts are
rate-limited and logged. Without the secret, claiming is disabled.

Accounts have no email verification or password reset yet (there is no email provider), so
keep your password somewhere safe.

Deck library: once you are the owner, open **Library** in the top bar and press "Import precons"
(about 200 decks, five minutes, safe to run again). The bracket panel asks
[Commander Spellbook](https://commanderspellbook.com) for combos; answers are cached per list.
When Wizards changes the Game Changers list, edit `server/data/brackets/game_changers.json` and
redeploy.

## Install on a phone

Open the site in Safari (iPhone) or Chrome (Android), then "Add to Home Screen". The app opens
full screen and the shell works offline; card data and images need a connection the first time.
