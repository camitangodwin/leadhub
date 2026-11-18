// Qualification eval: labelled leads → tier accuracy, confusion matrix, and the worst error type
// (a HOT lead marked cold/spam is the costly mistake). Runs the rules engine always, Claude too when a key is set.
//   npm run eval            → rules (+ Claude if ANTHROPIC_API_KEY is set)
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/db.js";
import { ruleQualify, qualify, aiEnabled } from "../src/ai.js";

const cases = fs.readFileSync(path.join(ROOT, "evals", "leads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const TIERS = ["hot", "warm", "cold", "spam"];

function report(name, results) {
  const m = Object.fromEntries(TIERS.map((a) => [a, Object.fromEntries(TIERS.map((b) => [b, 0]))]));
  for (const r of results) m[r.expect][r.got] = (m[r.expect][r.got] || 0) + 1;
  const correct = results.filter((r) => r.got === r.expect).length;
  const missedHot = results.filter((r) => r.expect === "hot" && ["cold", "spam"].includes(r.got)).length;
  console.log(`\n== ${name}: ${correct}/${results.length} correct (${Math.round((correct / results.length) * 100)}%) · hot leads lost to cold/spam: ${missedHot}`);
  console.log("expected \\ got   " + TIERS.map((t) => t.padStart(6)).join(""));
  for (const a of TIERS) console.log(a.padEnd(17) + TIERS.map((b) => String(m[a][b]).padStart(6)).join(""));
  for (const r of results.filter((x) => x.got !== x.expect)) console.log(`  ✗ ${r.id} expected ${r.expect}, got ${r.got}: ${r.reason}`);
  return { correct, total: results.length, missedHot };
}

const rules = cases.map((c) => { const q = ruleQualify({ message: c.message }); return { id: c.id, expect: c.expect, got: q.tier, reason: q.reason }; });
const out = { rules: report("Rules engine (offline)", rules) };

if (aiEnabled()) {
  const ai = [];
  for (const c of cases) { const q = await qualify({ message: c.message, source: "eval" }); ai.push({ id: c.id, expect: c.expect, got: q.tier, reason: q.reason }); }
  out.claude = report(`Claude (${process.env.CLAUDE_MODEL || "claude-haiku-5-5"})`, ai);
} else console.log("\n(Set ANTHROPIC_API_KEY to also evaluate the Claude qualifier.)");

fs.writeFileSync(path.join(ROOT, "evals", "last-run.json"), JSON.stringify({ at: new Date().toISOString(), ...out }, null, 2));
