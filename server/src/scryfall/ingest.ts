import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import type { DbHandle } from "../db/index.js";
import { cards } from "../db/schema.js";
import { scryfallJson, scryfallFetch } from "./client.js";
import { shouldKeep, toCardRow, type ScryfallCard } from "./map.js";

/**
 * Scryfall bulk ingest. Downloads the "default_cards" bulk file (one printing
 * per card per set; Scryfall ships it as gzipped JSON Lines, ~80 MB compressed)
 * and streams it line by line into SQLite, so memory stays flat regardless of
 * file size. Runs at most once at a time.
 */

interface BulkDataEntry {
  type: string;
  updated_at: string;
  /** Current format: one JSON object per line, gzipped. */
  jsonl_download_uri?: string;
  compressed_size?: number;
  /** Older format: a single JSON array. Kept as a fallback. */
  download_uri?: string;
  size?: number;
}

export interface IngestState {
  running: boolean;
  /** 0..1 progress of the current phase, best effort. */
  progress: number;
  phase: "idle" | "download" | "import" | "prune" | "done" | "error";
  error: string | null;
  startedAt: string | null;
}

export const META_LAST_INGEST = "last_ingest_at";
export const META_BULK_UPDATED = "bulk_updated_at";
export const META_BULK_DOWNLOADED = "bulk_downloaded_updated_at";
export const META_CARD_COUNT = "card_count";
export const META_RUN_ID = "ingest_run_id";

export class Ingestor {
  readonly state: IngestState = { running: false, progress: 0, phase: "idle", error: null, startedAt: null };
  private listeners: Array<() => void> = [];

  constructor(
    private readonly handle: DbHandle,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Called after a successful ingest (the search index rebuilds itself). */
  onComplete(fn: () => void): void {
    this.listeners.push(fn);
  }

  isStale(): boolean {
    const last = this.handle.getMeta(META_LAST_INGEST);
    if (!last) return true;
    const ageHours = (Date.now() - Date.parse(last)) / 3_600_000;
    return ageHours >= config.cardDataMaxAgeHours;
  }

  cardCount(): number {
    const row = this.handle.db.select({ n: sql<number>`count(*)` }).from(cards).get();
    return row?.n ?? 0;
  }

  /**
   * Run a full ingest. `file` skips the download and reads a local file
   * (.json array, .jsonl, or .jsonl.gz; used by tests and offline work).
   * `force` re-imports even if Scryfall's file has not changed since last time.
   */
  async run(opts: { force?: boolean; file?: string } = {}): Promise<void> {
    if (this.state.running) {
      this.log.info("ingest already running; ignoring request");
      return;
    }
    Object.assign(this.state, {
      running: true,
      progress: 0,
      phase: "download",
      error: null,
      startedAt: new Date().toISOString(),
    });
    const runId = Number(this.handle.getMeta(META_RUN_ID) ?? "0") + 1;
    try {
      let sourceFile = opts.file;
      if (!sourceFile) {
        const entry = await scryfallJson<BulkDataEntry>("https://api.scryfall.com/bulk-data/default-cards");
        const previous = this.handle.getMeta(META_BULK_UPDATED);
        if (!opts.force && previous === entry.updated_at && this.cardCount() > 0) {
          this.log.info({ updatedAt: entry.updated_at }, "bulk data unchanged; skipping import");
          this.handle.setMeta(META_LAST_INGEST, new Date().toISOString());
          this.state.phase = "done";
          return;
        }
        // If the machine was stopped mid-import last time, the finished download is still on disk.
        const onDisk = this.bulkPath(entry);
        if (fs.existsSync(onDisk) && this.handle.getMeta(META_BULK_DOWNLOADED) === entry.updated_at) {
          this.log.info("reusing previously downloaded bulk file");
          sourceFile = onDisk;
        } else {
          sourceFile = await this.download(entry);
          this.handle.setMeta(META_BULK_DOWNLOADED, entry.updated_at);
        }
        this.handle.setMeta(META_BULK_UPDATED, entry.updated_at);
      }

      this.state.phase = "import";
      this.state.progress = 0;
      const total = await this.importFile(sourceFile, runId);

      this.state.phase = "prune";
      const pruned = this.handle.db.delete(cards).where(sql`${cards.seenRun} <> ${runId}`).run();
      this.log.info({ imported: total, pruned: pruned.changes }, "ingest complete");

      this.handle.setMeta(META_RUN_ID, String(runId));
      this.handle.setMeta(META_CARD_COUNT, String(this.cardCount()));
      this.handle.setMeta(META_LAST_INGEST, new Date().toISOString());
      this.state.phase = "done";
      this.state.progress = 1;
      for (const fn of this.listeners) fn();
    } catch (err) {
      this.state.phase = "error";
      this.state.error = err instanceof Error ? err.message : String(err);
      this.log.error({ err }, "ingest failed");
    } finally {
      this.state.running = false;
    }
  }

  private bulkPath(entry: BulkDataEntry): string {
    return path.join(config.bulkDir, entry.jsonl_download_uri ? "default_cards.jsonl.gz" : "default_cards.json");
  }

  private async download(entry: BulkDataEntry): Promise<string> {
    const url = entry.jsonl_download_uri ?? entry.download_uri;
    if (!url) throw new Error("Scryfall bulk-data entry has no download URI");
    fs.mkdirSync(config.bulkDir, { recursive: true });
    const finalPath = this.bulkPath(entry);
    const tmpPath = `${finalPath}.tmp`;
    const expected = entry.compressed_size ?? entry.size ?? 0;
    this.log.info({ url, mb: Math.round(expected / 1e6) }, "downloading Scryfall bulk data");

    const res = await scryfallFetch(url, { headers: { Accept: "application/octet-stream, application/json" } });
    if (!res.ok || !res.body) throw new Error(`bulk download failed: HTTP ${res.status}`);
    const total = expected || Number(res.headers.get("content-length") ?? 0);
    let received = 0;
    const progress = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        received += chunk.length;
        if (total > 0) this.state.progress = Math.min(0.99, received / total);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as never), progress, fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, finalPath);
    this.state.progress = 1;
    return finalPath;
  }

  /** Stream a bulk file into the cards table. Returns rows written. */
  async importFile(file: string, runId: number): Promise<number> {
    const { db, sqlite } = this.handle;
    const BATCH = 500;
    let batch: ReturnType<typeof toCardRow>[] = [];
    let written = 0;

    const insertBatch = sqlite.transaction((rows: ReturnType<typeof toCardRow>[]) => {
      for (const row of rows) {
        db.insert(cards)
          .values(row)
          .onConflictDoUpdate({ target: cards.id, set: { ...row } })
          .run();
      }
    });
    const push = (card: ScryfallCard) => {
      if (!shouldKeep(card)) return;
      batch.push(toCardRow(card, runId));
      if (batch.length >= BATCH) flush();
    };
    const flush = () => {
      if (batch.length === 0) return;
      insertBatch(batch);
      written += batch.length;
      batch = [];
    };

    if (file.endsWith(".json")) {
      // Plain JSON array (test fixtures, legacy format). Small files only.
      const arr = JSON.parse(fs.readFileSync(file, "utf8")) as ScryfallCard[];
      for (const card of arr) push(card);
      flush();
      return written;
    }

    const fileSize = fs.statSync(file).size;
    let bytesSeen = 0;
    const raw = fs.createReadStream(file);
    raw.on("data", (chunk) => {
      bytesSeen += chunk.length;
      this.state.progress = Math.min(0.99, bytesSeen / fileSize);
    });
    const input = file.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "[" || trimmed === "]") continue;
      // Tolerate a trailing comma in case a line came from an array dump.
      const json = trimmed.endsWith(",") ? trimmed.slice(0, -1) : trimmed;
      push(JSON.parse(json) as ScryfallCard);
    }
    flush();
    return written;
  }
}
