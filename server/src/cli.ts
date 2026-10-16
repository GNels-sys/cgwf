/**
 * Admin command line. Usage:
 *   node server/dist/cli.js ingest [--force] [--file path/to/cards.json]
 *
 * If the server is running on this machine the command asks it to ingest
 * (so only one process touches the database); otherwise it runs the ingest itself.
 */
import { buildApp } from "./app.js";
import { config } from "./config.js";

const [, , command, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const fileIdx = rest.indexOf("--file");
const file = fileIdx >= 0 ? rest[fileIdx + 1] : undefined;

if (command !== "ingest") {
  console.error("usage: cli ingest [--force] [--file cards.json]");
  process.exit(2);
}

const force = flags.has("--force");

async function viaRunningServer(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/admin/ingest`, {
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
