// End-to-end check of the workflow and its guardrails on a throwaway database (no server needed).
//   node evals/e2e.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leadhub-"));
process.env.LEADHUB_DATA_DIR = tmp;
process.env.TIME_SPEED = "86400";          // one "day" per second
const P = await import("../src/pipeline.js");
const store = await import("../src/db.js");

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}`); };

const hot = (await P.intake({ name: "Daniel Tan", email: "daniel@example.com", message: "Want to sell our Tampines HDB within the next month, can you do a valuation this week?" })).lead;
check("hot lead qualified as hot", hot.qualification.tier === "hot");
check("first reply sent automatically", store.get().outbox.some((m) => m.leadId === hot.id && m.kind === "first reply"));
check("first reply only uses business facts (booking link present, no prices)", hot.firstReply.body.includes("example.com/book") && !/\$\s?\d/.test(hot.firstReply.body));
check("hot-lead alert raised", store.get().alerts.some((a) => a.leadId === hot.id));
check("3 follow-ups scheduled", (hot.followUps || []).length === 3);

const dup = await P.intake({ name: "Daniel T", email: "DANIEL@example.com ", message: "any update?" });
check("same email (different case) merged, not a second lead", dup.duplicate === true && Object.keys(store.get().leads).length === 1);
check("no second first-reply to the duplicate", store.get().outbox.filter((m) => m.leadId === hot.id && m.kind.startsWith("first")).length === 1);

const spam = (await P.intake({ name: "SEO Co", email: "x@seo.example", message: "SEO services and backlinks at a discount" })).lead;
check("spam stopped by guardrail before any AI call", spam.stage === "spam" && spam.qualification.engine === "rules");

const warm = (await P.intake({ name: "Grace", email: "grace@example.com", message: "Thinking of renting out my Punggol unit later this year" })).lead;
await new Promise((r) => setTimeout(r, 1200));   // 1.2 "days" pass
P.tick();
check("day-1 follow-up sent when due", warm.followUps[0].status === "sent");

await P.inbound(warm.id, "Thanks! Can we talk on Friday?");
check("reply from lead cancels remaining follow-ups", warm.followUps.slice(1).every((f) => f.status === "cancelled") && warm.stage === "replied");

await P.inbound(hot.id, "Please STOP messaging me");
check("STOP → do-not-contact, follow-ups cancelled", hot.stage === "do_not_contact" && hot.followUps.every((f) => f.status !== "scheduled"));
const again = (await P.intake({ name: "Daniel", email: "someone-else@example.com", phone: "", message: "hello" })).lead;
const blocked = (await P.intake({ name: "D", email: "daniel@example.com", message: "new enquiry" }));
check("opted-out contact never gets a new reply", blocked.duplicate === true && !store.get().outbox.some((m) => m.leadId === hot.id && m.at > new Date(Date.now() - 500).toISOString() && m.kind.startsWith("first")));
void again;

check("every automated step is in the audit trail", hot.timeline.map((t) => t.action).join(",").includes("received,qualified,sent"));

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
