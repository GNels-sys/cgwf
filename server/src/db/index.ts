import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { config, ensureDataDirs } from "../config.js";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  close(): void;
}

/** Open (creating if needed) the SQLite file and apply pending migrations. */
export function openDb(file: string = config.dbFile): DbHandle {
  ensureDataDirs();
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: config.migrationsDir });

  return {
    db,
    sqlite,
    getMeta(key) {
      const row = db.select().from(schema.meta).where(eq(schema.meta.key, key)).get();
      return row?.value ?? null;
    },
    setMeta(key, value) {
      db.insert(schema.meta)
        .values({ key, value })
        .onConflictDoUpdate({ target: schema.meta.key, set: { value } })
        .run();
    },
    close() {
      sqlite.close();
    },
  };
}

export { schema };
