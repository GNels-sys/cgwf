import { defineConfig } from "drizzle-kit";

// Only used by `npm run db:generate` to write SQL migrations into ./drizzle.
// The running server applies those migrations itself on boot (see src/db/index.ts).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_FILE ?? "../data/cgwf.db" },
});
