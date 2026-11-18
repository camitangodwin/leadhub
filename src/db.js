// Tiny JSON-file store (one file, written atomically) — enough for a demo and easy to swap for Postgres.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.LEADHUB_DATA_DIR || path.join(ROOT, "data");
const FILE = path.join(DIR, "leads.json");
const EMPTY = { leads: {}, outbox: [], alerts: [], optOuts: {}, audit: [] };

let db = null;
export function get() {
  if (db) return db;
  fs.mkdirSync(DIR, { recursive: true });
  db = fs.existsSync(FILE) ? { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(FILE, "utf8")) } : structuredClone(EMPTY);
  return db;
}
export function save() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(get(), null, 1));
  fs.renameSync(tmp, FILE);
}
export function reset() { db = structuredClone(EMPTY); save(); }

/** Append to the audit trail (every automated decision is recorded with its reason). */
export function audit(leadId, action, detail = "") {
  const d = get();
  const entry = { at: new Date().toISOString(), leadId, action, detail };
  d.audit.push(entry);
  d.audit = d.audit.slice(-2000);
  if (leadId && d.leads[leadId]) (d.leads[leadId].timeline ||= []).push(entry);
  return entry;
}
