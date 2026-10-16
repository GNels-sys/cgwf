/**
 * Admin command line. Usage:
 *   node server/dist/cli.js ingest [--force] [--file path/to/cards.json]
 *   node server/dist/cli.js import-precons [--force] [--no-combos]
 *
 * If the server is running on this machine the command asks it to do the work
 * (so only one process touches the database); otherwise `ingest` runs locally.
 * `import-precons` needs the running server (it is what the owner runs through
 * `fly ssh console` after a deploy); it polls progress until the import ends.
 */
import { buildApp } from "./app.js";
import { config } from "./config.js";

const [, , command, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const fileIdx = rest.indexOf("--file");
const file = fileIdx >= 0 ? rest[fileIdx + 1] : undefined;
const force = flags.has("--force");
const base = `http://127.0.0.1:${config.port}`;

if (command !== "ingest" && command !== "import-precons") {
  console.error("usage: cli ingest [--force] [--file cards.json] | cli import-precons [--force] [--no-combos]");
  process.exit(2);
}

async function viaRunningServer(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/admin/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    });
    if (res.status === 202) {
      console.log("ingest started on the running server; watch /api/status for progress");
      return true;
    }
    if (res.status === 409) {
      console.log("server says an ingest is already running");
      return true;
    }
    console.error(`server answered ${res.status}; falling back to a local run`);
    return false;
  } catch {
    return false;
  }
}

async function importPrecons(): Promise<void> {
  const res = await fetch(`${base}/api/admin/import-precons`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ force, combos: !flags.has("--no-combos") }),
  });
  if (res.status !== 202 && res.status !== 409) {
    console.error(`server answered ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  console.log(res.status === 409 ? "an import is already running; following it" : "precon import started");
  let last = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = (await (await fetch(`${base}/api/admin/import-status`)).json()) as { importState: { running: boolean; phase: string; total: number; done: number; imported: number; skipped: number; errors: string[]; error: string | null } };
    const s = status.importState;
    const line = `${s.phase} ${s.done}/${s.total} imported=${s.imported} skipped=${s.skipped} errors=${s.errors.length}`;
    if (line !== last) console.log(line);
    last = line;
    if (!s.running) {
      for (const e of s.errors) console.log(`  problem: ${e}`);
      if (s.error) {
        console.error(`import failed: ${s.error}`);
        process.exit(1);
      }
      return;
    }
  }
}

if (command === "import-precons") {
  await importPrecons();
  process.exit(0);
}

if (!file && (await viaRunningServer())) process.exit(0);

const { app, ingestor } = await buildApp({ logger: "plain" });
const opts: { force: boolean; file?: string } = { force };
if (file) opts.file = file;
await ingestor.run(opts);
await app.close();
if (ingestor.state.phase === "error") {
  console.error(`ingest failed: ${ingestor.state.error}`);
  process.exit(1);
}
console.log(`done: ${ingestor.cardCount()} cards`);
