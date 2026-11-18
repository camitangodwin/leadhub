// The lead workflow: intake → guardrails → qualify → grounded first reply → hot-lead escalation → follow-ups.
// Every automated decision is written to the lead's timeline with its reason.
import { EventEmitter } from "node:events";
import * as store from "./db.js";
import * as guard from "./guard.js";
import { qualify, draftReply, BIZ } from "./ai.js";

export const bus = new EventEmitter();   // "change" → dashboard refresh
const changed = () => { store.save(); bus.emit("change"); };

const SPEED = Number(process.env.TIME_SPEED || 1);              // 1440 → one "day" per minute in demos
const DAY = 86400000 / SPEED;
const FOLLOW_UPS = [1, 3, 7];                                    // days after the first reply
const approval = () => String(process.env.REQUIRE_APPROVAL || "false") === "true";
const id = () => "L" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

// ---------- intake ----------
export async function intake(input, sourceKey = "form") {
  const t0 = Date.now();
  const raw = {
    name: String(input.name || "").trim().slice(0, 120), email: String(input.email || "").trim().slice(0, 200),
    phone: String(input.phone || "").trim().slice(0, 40), message: String(input.message || "").trim().slice(0, 4000),
    source: String(input.source || sourceKey).slice(0, 60),
  };
  if (guard.rateLimited(sourceKey)) return { ok: false, status: 429, error: "Too many submissions — try again in a minute." };

  // Duplicate person → append to the existing lead instead of creating a second one (no double outreach)
  const dup = guard.findDuplicate(raw);
  if (dup) {
    store.audit(dup.id, "duplicate", `Same ${dup.emailNorm === guard.normEmail(raw.email) ? "email" : "phone"} submitted again via ${raw.source}; merged, no second reply sent.`);
    (dup.messages ||= []).push({ at: new Date().toISOString(), from: "lead", text: raw.message, channel: raw.source });
    changed();
    return { ok: true, lead: dup, duplicate: true };
  }

  const lead = {
    id: id(), ...raw, emailNorm: guard.normEmail(raw.email), phoneNorm: guard.normPhone(raw.phone),
    createdAt: new Date().toISOString(), stage: "new", timeline: [], messages: [{ at: new Date().toISOString(), from: "lead", text: raw.message, channel: raw.source }],
  };
  store.get().leads[lead.id] = lead;
  store.audit(lead.id, "received", `via ${lead.source} (${guard.maskEmail(lead.email) || guard.maskPhone(lead.phone)})`);

  if (guard.isOptedOut(lead)) { lead.stage = "do_not_contact"; store.audit(lead.id, "blocked", "Contact is on the opt-out list; no outreach."); changed(); return { ok: true, lead }; }
  const spam = guard.spamReason(lead);
  if (spam) { lead.stage = "spam"; lead.qualification = { tier: "spam", score: 0, reason: `Guardrail: ${spam}.`, engine: "rules" }; store.audit(lead.id, "rejected", `Guardrail: ${spam}. No AI call made.`); changed(); return { ok: true, lead }; }
  if (guard.wantsOptOut(lead.message)) { guard.optOut(lead, "asked in first message"); lead.stage = "do_not_contact"; store.audit(lead.id, "opt_out", "Asked not to be contacted."); changed(); return { ok: true, lead }; }
  changed();

  // AI steps
  const q = await qualify(lead);
  lead.qualification = q;
  lead.stage = q.tier === "spam" ? "spam" : "qualified";
  store.audit(lead.id, "qualified", `${q.tier.toUpperCase()} ${q.score}/100 · ${q.intent} · next: ${q.next_action} · ${q.reason} [${q.engine}]`);
  changed();
  if (q.tier === "spam") return { ok: true, lead };

  const reply = await draftReply(lead, q);
  lead.firstReply = { ...reply, draftedAt: new Date().toISOString() };
  if (reply.check?.problems?.length) store.audit(lead.id, "fact_check", `AI draft rejected (${reply.check.problems.join("; ")}); safe template used instead.`);
  if (approval()) { lead.stage = "awaiting_approval"; store.audit(lead.id, "drafted", `Reply drafted [${reply.engine}] — waiting for human approval.`); }
  else send(lead, reply.subject, reply.body, "first reply");
  lead.responseSeconds = Math.round((Date.now() - t0) / 1000);
  if (!approval()) store.audit(lead.id, "speed", `First reply out ${lead.responseSeconds}s after the lead arrived.`);

  if (q.tier === "hot") await escalate(lead);
  if (!approval()) scheduleFollowUps(lead);
  changed();
  return { ok: true, lead };
}

// ---------- outbound (simulated outbox — swap for an email/SMS provider) ----------
function send(lead, subject, body, kind) {
  if (guard.isOptedOut(lead)) { store.audit(lead.id, "blocked", `${kind} not sent: opted out.`); return false; }
  const msg = { at: new Date().toISOString(), leadId: lead.id, to: lead.email || lead.phone, subject, body, kind };
  store.get().outbox.push(msg);
  (lead.messages ||= []).push({ at: msg.at, from: "us", text: body, channel: kind });
  if (lead.stage === "qualified" || lead.stage === "awaiting_approval" || lead.stage === "new") lead.stage = "contacted";
  store.audit(lead.id, "sent", `${kind} → ${guard.maskEmail(lead.email) || guard.maskPhone(lead.phone)}`);
  return true;
}

export function approve(leadId, edited) {
  const lead = store.get().leads[leadId];
  if (!lead || lead.stage !== "awaiting_approval") return { ok: false, error: "Nothing waiting for approval." };
  const body = edited?.body || lead.firstReply.body;
  send(lead, lead.firstReply.subject, body, "first reply (approved)");
  scheduleFollowUps(lead);
  if (edited?.body) store.audit(lead.id, "edited", "Human edited the reply before sending.");
  changed();
  return { ok: true, lead };
}

// ---------- hot-lead escalation ----------
async function escalate(lead) {
  const q = lead.qualification;
  const text = `🔥 Hot lead: ${lead.name || "Unknown"} — ${q.intent}${q.area !== "unknown" ? " in " + q.area : ""}, ${q.timeline}. ${q.reason} Next: ${q.next_action.replace(/_/g, " ")}.`;
  store.get().alerts.unshift({ at: new Date().toISOString(), leadId: lead.id, text });
  let where = "dashboard";
  if (process.env.SLACK_WEBHOOK_URL) {
    try {
      const r = await fetch(process.env.SLACK_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(8000) });
      where = r.ok ? "Slack + dashboard" : `dashboard (Slack HTTP ${r.status})`;
    } catch (e) { where = `dashboard (Slack failed: ${e.message})`; }
  }
  store.audit(lead.id, "escalated", `Hot lead alert → ${where}.`);
}

// ---------- follow-ups ----------
function scheduleFollowUps(lead) {
  const base = Date.now();
  lead.followUps = FOLLOW_UPS.map((d, i) => ({ step: i + 1, dueAt: new Date(base + d * DAY).toISOString(), status: "scheduled" }));
  store.audit(lead.id, "scheduled", `Follow-ups on day ${FOLLOW_UPS.join(", ")} (stop automatically if they reply or opt out).`);
}

const followText = (lead, step) => {
  const first = (lead.name || "there").split(" ")[0];
  return [
    `Hi ${first}, just checking you saw my note. Happy to answer any questions — or grab a time here: ${BIZ.bookingLink}\n\n${BIZ.agentName}`,
    `Hi ${first}, a quick one: is ${lead.qualification?.intent === "sell" ? "a free valuation" : "a short call"} still useful this week? ${BIZ.bookingLink}\n\n${BIZ.agentName}`,
    `Hi ${first}, I'll leave it here so I don't crowd your inbox. Whenever you're ready, I'm one reply away.\n\n${BIZ.agentName}, ${BIZ.name}`,
  ][step - 1];
};

/** Runs every few seconds: sends follow-ups that are due, unless the lead replied, opted out or is closed. */
export function tick(now = Date.now()) {
  let any = false;
  for (const lead of Object.values(store.get().leads)) {
    for (const f of lead.followUps || []) {
      if (f.status !== "scheduled" || Date.parse(f.dueAt) > now) continue;
      if (["replied", "won", "lost", "do_not_contact"].includes(lead.stage) || guard.isOptedOut(lead)) { f.status = "cancelled"; any = true; continue; }
      send(lead, `Re: ${lead.firstReply?.subject || BIZ.name}`, followText(lead, f.step), `follow-up ${f.step}`);
      f.status = "sent"; any = true;
    }
  }
  if (any) changed();
}

// ---------- the lead writes back ----------
export async function inbound(leadId, text) {
  const lead = store.get().leads[leadId];
  if (!lead) return { ok: false, error: "Unknown lead." };
  (lead.messages ||= []).push({ at: new Date().toISOString(), from: "lead", text, channel: "reply" });
  for (const f of lead.followUps || []) if (f.status === "scheduled") f.status = "cancelled";
  if (guard.wantsOptOut(text)) {
    guard.optOut(lead, "replied STOP");
    lead.stage = "do_not_contact";
    store.audit(lead.id, "opt_out", "Lead asked to stop. All follow-ups cancelled; contact blocked permanently.");
  } else {
    lead.stage = "replied";
    store.audit(lead.id, "replied", "Lead replied — follow-ups cancelled; a human takes over.");
    const q = await qualify({ ...lead, message: lead.messages.filter((m) => m.from === "lead").map((m) => m.text).join("\n---\n") });
    const was = lead.qualification?.tier;
    lead.qualification = q;
    store.audit(lead.id, "requalified", `${q.tier.toUpperCase()} ${q.score}/100 after reply (was ${was}). [${q.engine}]`);
    if (q.tier === "hot" && was !== "hot") await escalate(lead);
  }
  changed();
  return { ok: true, lead };
}

export function setStage(leadId, stage) {
  const lead = store.get().leads[leadId];
  if (!lead || !["won", "lost", "contacted", "replied"].includes(stage)) return { ok: false };
  lead.stage = stage;
  store.audit(lead.id, "stage", `Moved to ${stage} by a human.`);
  changed();
  return { ok: true, lead };
}

export function stats() {
  const leads = Object.values(store.get().leads);
  const by = (k) => leads.reduce((m, l) => ((m[k(l)] = (m[k(l)] || 0) + 1), m), {});
  const rt = leads.map((l) => l.responseSeconds).filter((x) => typeof x === "number").sort((a, b) => a - b);
  return {
    total: leads.length, byStage: by((l) => l.stage), byTier: by((l) => l.qualification?.tier || "pending"),
    medianFirstReplySeconds: rt.length ? rt[Math.floor(rt.length / 2)] : null,
    outbox: store.get().outbox.length, alerts: store.get().alerts.length, optOuts: Object.keys(store.get().optOuts).length,
  };
}
