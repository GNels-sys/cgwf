# CGwF - Card Games with Friends

A private, installable web app for playing tabletop card games with friends over the internet:
a perfectly synced virtual table with real card images. Players enforce the rules themselves.

CGwF is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by
Wizards. Portions of the materials used are property of Wizards of the Coast. (c) Wizards of the
Coast LLC. Card data and images courtesy of [Scryfall](https://scryfall.com).

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

## Install on a phone

Open the site in Safari (iPhone) or Chrome (Android), then "Add to Home Screen". The app opens
full screen and the shell works offline; card data and images need a connection the first time.
