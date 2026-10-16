import { buildApp } from "./app.js";
import { config } from "./config.js";

const { app, ingestor } = await buildApp();

await app.listen({ port: config.port, host: config.host });

// Keep card data fresh: refresh on boot if stale, then check hourly while awake.
// (The machine scales to zero between games, so a fixed nightly cron would often miss.)
function maybeIngest(reason: string): void {
  if (config.skipAutoIngest) return;
  if (ingestor.isStale() && !ingestor.state.running) {
    app.log.info({ reason }, "card data stale; starting Scryfall ingest");
    void ingestor.run();
  }
}
setTimeout(() => maybeIngest("boot"), 3_000);
setInterval(() => maybeIngest("hourly check"), 3_600_000).unref();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
