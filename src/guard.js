// Guardrails that run in code, before any AI is involved.
import * as store from "./db.js";

export const normEmail = (e = "") => e.trim().toLowerCase();
export const normPhone = (p = "") => {
  const d = String(p).replace(/\D/g, "");
  return d.length === 8 ? "65" + d : d;            // Singapore local numbers → +65
};

/** Same person = same email or same phone. Returns the existing lead or null. */
export function findDuplicate({ email, phone }) {
  const e = normEmail(email), p = normPhone(phone);
  return Object.values(store.get().leads).find((l) => (e && l.emailNorm === e) || (p && p.length >= 8 && l.phoneNorm === p)) || null;
}

const OPT_OUT = /\b(stop|unsubscribe|remove me|do not contact|don'?t contact|opt[- ]?out)\b/i;
export const wantsOptOut = (text = "") => OPT_OUT.test(text);
export function optOut(lead, why) {
  const d = store.get();
  if (lead.emailNorm) d.optOuts[lead.emailNorm] = { at: new Date().toISOString(), why };
  if (lead.phoneNorm) d.optOuts[lead.phoneNorm] = { at: new Date().toISOString(), why };
}
export const isOptedOut = (lead) => {
  const o = store.get().optOuts;
  return Boolean((lead.emailNorm && o[lead.emailNorm]) || (lead.phoneNorm && o[lead.phoneNorm]));
};

/** Obvious junk is rejected before spending a model call on it. */
const SPAM = /(https?:\/\/\S+.*){3,}|\b(seo services|backlinks|crypto (investment|signal)|casino|loan offer|guest post|viagra)\b/i;
export function spamReason({ name = "", email = "", phone = "", message = "" }) {
  if (SPAM.test(message)) return "spam keywords or link stuffing";
  if (email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return "invalid email";
  if (!email && normPhone(phone).length < 8) return "no way to contact";
  if (message.length > 4000) return "message too long";
  if (/^[^a-z]*$/i.test(name + message)) return "no readable text";
  return null;
}

/** Simple per-source rate limit (stops form floods). */
const hits = new Map();
export function rateLimited(key, max = 10, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}

/** Logs never show full contact details. */
export const maskEmail = (e = "") => e.replace(/^(.).*?(.)?@/, (m, a, b) => `${a}***${b || ""}@`);
export const maskPhone = (p = "") => String(p).replace(/\d(?=\d{3})/g, "•");
