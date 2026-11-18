// AI layer: qualify a lead and draft a grounded first reply.
// Uses Claude (structured output) when ANTHROPIC_API_KEY is set; otherwise a transparent rule-based fallback,
// so the whole pipeline runs offline and the evals can compare both.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ROOT } from "./db.js";

export const BIZ = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "business.json"), "utf8"));
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
let _client;
const client = () => (_client ||= new Anthropic());

async function parse(system, user, schema, maxTokens = 3000) {
  const res = await client().messages.parse({
    model: MODEL, max_tokens: maxTokens,
    system, messages: [{ role: "user", content: user }],
    output_config: { effort: "low", format: zodOutputFormat(schema) },
  });
  if (!res.parsed_output) throw new Error(`no structured output (stop_reason ${res.stop_reason})`);
  return res.parsed_output;
}

const leadText = (l) => `Name: ${l.name || "-"}\nSource: ${l.source || "-"}\nMessage:\n${(l.message || "").slice(0, 3000)}`;

// ---------- 1. Qualification ----------
export const Qualification = z.object({
  tier: z.enum(["hot", "warm", "cold", "spam"]),
  score: z.number().int().min(0).max(100),
  intent: z.enum(["buy", "sell", "rent", "landlord", "question", "other"]),
  timeline: z.string().describe("e.g. 'within 30 days', 'next year', 'unknown'"),
  budget: z.string().describe("amount/range if stated, else 'unknown'"),
  area: z.string().describe("area mentioned, else 'unknown'"),
  in_service_area: z.boolean(),
  reason: z.string().describe("one sentence, cites what in the message drove the tier"),
  next_action: z.enum(["call_now", "book_viewing", "book_valuation", "send_info", "nurture", "discard"]),
});

export async function qualify(lead) {
  if (!aiEnabled()) return { ...ruleQualify(lead), engine: "rules" };
  try {
    const q = await parse(
      `You qualify inbound leads for ${BIZ.name}, a ${BIZ.industry} agency serving ${BIZ.areas.join(", ")}.
Hot = clear intent AND (timeline within ~60 days OR asks for viewing/valuation/call OR budget/financing ready). Warm = real interest, no urgency. Cold = vague or far off. Spam = sales pitches, irrelevant, junk.
Out-of-area or commercial property: not hot. Base everything only on the message; use "unknown" when not stated. Be calibrated: score 80-100 hot, 50-79 warm, 10-49 cold, 0-9 spam.`,
      leadText(lead), Qualification, 2000);
    return { ...q, engine: "claude" };
  } catch (e) {
    return { ...ruleQualify(lead), engine: "rules (AI failed: " + e.message.slice(0, 80) + ")" };
  }
}

/** Deterministic fallback — readable on purpose, so a reviewer can see exactly why a lead got its tier. */
export function ruleQualify(lead) {
  const t = `${lead.message || ""}`.toLowerCase();
  const intent = /\b(sell|selling|valuation|value my|list my)\b/.test(t) ? "sell"
    : /\b(rent(ing)? out|landlord|my unit for rent)\b/.test(t) ? "landlord"
    : /\b(rent|rental|lease|tenant)\b/.test(t) ? "rent"
    : /\b(buy|buying|purchase|looking for|resale|condo|hdb|flat)\b/.test(t) ? "buy"
    : /\?/.test(t) ? "question" : "other";
  const area = BIZ.areas.find((a) => t.includes(a.toLowerCase())) || "unknown";
  const urgent = /\b(asap|urgent|today|this week|this weekend|next week|this month|next month|immediately|soon|move fast)\b|\b(in|within) (the next )?(\d{1,2}|a|one|two|three|few|couple of) (days?|weeks?)\b|\bwithin (the next )?(a|one|1|2|two) months?\b/.test(t);
  const farOff = /\b(next year|in (two|2|a few) years|just exploring|just curious|curious about|someday|no rush)\b/.test(t);
  const action = /\b(viewing|view the|valuation|call me|call back|appointment|meet)\b/.test(t);
  const money = /(\$|sgd|budget|loan|approved|financing|in-principle|ipa|cash)/.test(t);
  const commercial = /\b(office|shophouse|warehouse|factory|commercial|industrial)\b/.test(t);
  const spam = /\b(seo|backlink|marketing services|guest post|crypto|casino|we can help your business)\b/.test(t);
  let score = 20 + (intent !== "other" && intent !== "question" ? 30 : 0) + (urgent ? 20 : 0) + (action ? 20 : 0) + (money ? 15 : 0) + (area !== "unknown" ? 5 : 0);
  if (farOff) score -= 25;
  if (commercial) score = Math.min(score, 30);
  if (spam) score = 2;
  score = Math.max(0, Math.min(100, score));
  const tier = spam ? "spam" : score >= 80 ? "hot" : score >= 50 ? "warm" : "cold";
  const next_action = tier === "spam" ? "discard" : tier === "hot" ? (intent === "sell" ? "book_valuation" : action ? "book_viewing" : "call_now") : tier === "warm" ? "send_info" : "nurture";
  const why = [intent !== "other" && `intent: ${intent}`, urgent && "near-term timeline", farOff && "far-off or just exploring", action && "asked for viewing/valuation/call", money && "budget/financing mentioned", commercial && "commercial property (not served)", spam && "sales pitch / spam"].filter(Boolean).join(", ");
  return {
    tier, score, intent, timeline: urgent ? "soon (stated)" : "unknown", budget: money ? "mentioned" : "unknown", area,
    in_service_area: area !== "unknown", reason: why ? `Rules: ${why}.` : "Rules: no clear intent or urgency.", next_action,
  };
}

// ---------- 2. Grounded first reply ----------
const Reply = z.object({
  subject: z.string(),
  body: z.string().describe("plain text, 60-120 words, signed by the agent"),
  facts_used: z.array(z.string()).describe("each business fact the reply relies on, copied from the FACTS list"),
});
const Check = z.object({
  ok: z.boolean(),
  problems: z.array(z.string()).describe("claims not supported by FACTS (prices, commission, dates, availability, guarantees)"),
});
const FACTS = () => [...BIZ.services, ...BIZ.facts, `Areas: ${BIZ.areas.join(", ")}`, `Hours: ${BIZ.hours}`, `Booking link: ${BIZ.bookingLink}`].map((f) => "- " + f).join("\n");

/** Draft a reply that may only use the business facts, then verify it. Fails closed to a safe template. */
export async function draftReply(lead, q) {
  if (!aiEnabled()) return { ...templateReply(lead, q), engine: "template", check: { ok: true, problems: [] } };
  try {
    const r = await parse(
      `You are ${BIZ.agentName} from ${BIZ.name}. Write the first reply to a new lead within the next minute. Warm, specific to what they asked, short.
Use ONLY these facts; never state prices, commission, availability of specific units, dates or guarantees that are not in the facts. If they ask something the facts don't cover, say ${BIZ.agentName} will confirm on a call.
Close with ONE clear next step that matches next_action, using the booking link.
FACTS:\n${FACTS()}`,
      `${leadText(lead)}\n\nQualification: ${JSON.stringify({ tier: q.tier, intent: q.intent, next_action: q.next_action, area: q.area })}`, Reply);
    const check = await parse(
      `Check a sales reply against the business FACTS. Flag any claim about prices, commission, specific listings, dates, availability, guarantees or services that the facts do not support. Greetings, empathy and asking questions are fine.\nFACTS:\n${FACTS()}`,
      `REPLY:\n${r.body}`, Check, 1500);
    if (!check.ok && check.problems.length) return { ...templateReply(lead, q), engine: "template (AI draft failed the fact check)", check, rejectedDraft: r.body };
    return { subject: r.subject, body: r.body, engine: "claude", check, facts_used: r.facts_used };
  } catch (e) {
    return { ...templateReply(lead, q), engine: "template (AI error: " + e.message.slice(0, 80) + ")", check: { ok: true, problems: [] } };
  }
}

export function templateReply(lead, q) {
  const first = (lead.name || "there").split(" ")[0];
  const step = {
    book_valuation: `The quickest next step is a free 30-minute valuation, in person or by video call. You can pick a time here: ${BIZ.bookingLink}`,
    book_viewing: `Viewings run 7 days a week, 10 AM to 8 PM. Pick a slot that suits you here: ${BIZ.bookingLink}`,
    call_now: `I'll give you a quick call shortly. If you prefer a set time, book it here: ${BIZ.bookingLink}`,
    send_info: `Happy to share options that fit. When is a good time for a short call? ${BIZ.bookingLink}`,
    nurture: `Whenever you're ready, you can book a short call here: ${BIZ.bookingLink}`,
  }[q.next_action] || `You can book a short call here: ${BIZ.bookingLink}`;
  const what = { buy: "finding your next home", sell: "selling your home", rent: "finding a rental", landlord: "renting out your unit" }[q.intent] || "your enquiry";
  return {
    subject: `Re: ${what} — ${BIZ.name}`,
    body: `Hi ${first},\n\nThanks for reaching out to ${BIZ.name} about ${what}${q.area !== "unknown" ? ` in ${q.area}` : ""}. ${step}\n\nBest,\n${BIZ.agentName}\n${BIZ.name}`,
  };
}
