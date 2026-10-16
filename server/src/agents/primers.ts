import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * The two hand-written primers every agent reads (server/data/agents/*.md,
 * shipped in the image). Loaded once; edit the files and restart to change
 * how agents are briefed.
 */
let cached: { rules: string; effects: string } | null = null;

export function loadPrimers(dir: string = config.agentDataDir): { rules: string; effects: string } {
  if (cached && dir === config.agentDataDir) return cached;
  const read = (name: string) => {
    const file = path.join(dir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : `(missing ${name})`;
  };
  const out = { rules: read("rules-primer.md"), effects: read("effects-primer.md") };
  if (dir === config.agentDataDir) cached = out;
  return out;
}
