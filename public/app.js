const $ = (s) => document.querySelector(s);
const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const api = (url, body) => fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());

let S = null, openId = null;
const COLS = [
  ["New / qualifying", (l) => ["new", "qualified", "awaiting_approval"].includes(l.stage)],
  ["Contacted", (l) => l.stage === "contacted"],
  ["Replied", (l) => l.stage === "replied"],
  ["Won / lost", (l) => ["won", "lost"].includes(l.stage)],
  ["Filtered out", (l) => ["spam", "do_not_contact"].includes(l.stage)],
];

async function refresh() {
  S = await api("/api/state");
  $("#biz").textContent = S.business;
  $("#aiChip").textContent = "AI: " + S.ai;
  $("#modeChip").textContent = (S.approval ? "Human approval" : "Auto-reply") + (S.speed > 1 ? ` · time ×${S.speed}` : "");
  const st = S.stats;
  $("#stats").innerHTML = [
    ["Leads", st.total], ["Hot", st.byTier.hot || 0], ["Median 1st reply", st.medianFirstReplySeconds == null ? "—" : st.medianFirstReplySeconds + "s"],
    ["Messages sent", st.outbox], ["Opt-outs", st.optOuts],
  ].map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join("");
  $("#board").innerHTML = COLS.map(([title, fn]) => {
    const items = S.leads.filter(fn);
    return `<div class="col"><h3>${title}<span>${items.length}</span></h3>${items.map(card).join("") || '<div class="hint">—</div>'}</div>`;
  }).join("");
  $("#alerts").innerHTML = S.alerts.map((a) => `<div class="it hot">${esc(a.text)}<small>${ago(a.at)}</small></div>`).join("") || '<div class="hint">No hot leads yet.</div>';
  $("#outbox").innerHTML = S.outbox.map((m) => `<div class="it"><b>${esc(m.kind)}</b> → ${esc(m.to.replace(/^(.).*?@/, "$1***@"))}<small>${ago(m.at)}</small></div>`).join("") || '<div class="hint">Nothing sent yet.</div>';
  if (openId) openLead(openId);
}

function card(l) {
  const q = l.qualification || {};
  const tier = q.tier || "pending";
  const pending = l.stage === "awaiting_approval" ? " · needs approval" : "";
  const fu = (l.followUps || []).filter((f) => f.status === "scheduled").length;
  return `<div class="lead" onclick="openLead('${l.id}')">
    <div class="top"><span class="nm">${esc(l.name || "Unknown")}</span><span class="tier ${tier}">${tier}${q.score != null ? " " + q.score : ""}</span></div>
    <div class="msg">${esc(l.message)}</div>
    <div class="meta">${esc(l.source)} · ${ago(l.createdAt)}${l.responseSeconds != null ? ` · replied in ${l.responseSeconds}s` : ""}${fu ? ` · ${fu} follow-ups queued` : ""}${pending}</div>
  </div>`;
}

window.openLead = (id) => {
  const l = S.leads.find((x) => x.id === id); if (!l) return;
  openId = id;
  const q = l.qualification || {};
  const r = l.firstReply;
  $("#dTitle").innerHTML = `${esc(l.name || "Unknown")} <span class="tier ${q.tier || "pending"}">${q.tier || "pending"}</span>`;
  $("#dBody").innerHTML = `
    <div class="kv">
      <span>Stage</span><b>${esc(l.stage.replace(/_/g, " "))}</b>
      <span>Contact</span><div>${esc(l.email || "")} ${esc(l.phone || "")}</div>
      <span>Source</span><div>${esc(l.source)}</div>
      ${q.tier ? `<span>Score</span><div>${q.score}/100 · ${esc(q.intent || "")} · next: ${esc((q.next_action || "").replace(/_/g, " "))}</div>
      <span>Timeline / budget</span><div>${esc(q.timeline || "")} · ${esc(q.budget || "")}${q.area && q.area !== "unknown" ? " · " + esc(q.area) : ""}</div>
      <span>Why</span><div>${esc(q.reason || "")} <small>[${esc(q.engine || "")}]</small></div>` : ""}
    </div>
    ${r ? `<h4>First reply · ${esc(r.engine)}</h4>
      ${r.rejectedDraft ? `<div class="box bad"><b>AI draft rejected by the fact check:</b> ${esc(r.check.problems.join("; "))}\n\n${esc(r.rejectedDraft)}</div>` : ""}
      ${l.stage === "awaiting_approval"
        ? `<textarea id="apBody" rows="8" style="width:100%">${esc(r.body)}</textarea><div class="row"><button onclick="approve('${l.id}')">Approve & send</button></div>`
        : `<div class="box">${esc(r.body)}</div>`}` : ""}
    ${(l.followUps || []).length ? `<h4>Follow-ups</h4><div>${l.followUps.map((f) => `Follow-up ${f.step}: <b>${f.status}</b> <small>(${f.status === "scheduled" ? "due " + new Date(f.dueAt).toLocaleString() : ""})</small>`).join("<br>")}</div>` : ""}
    <h4>Conversation</h4>
    <div class="msgs">${(l.messages || []).map((m) => `<div class="m ${m.from}">${esc(m.text)}<br><small>${m.from === "us" ? "us · " : ""}${esc(m.channel)} · ${ago(m.at)}</small></div>`).join("")}</div>
    ${!["spam", "do_not_contact"].includes(l.stage) ? `<div class="row"><input id="inText" placeholder='Reply as the lead (try "STOP")'><button class="small" onclick="inbound('${l.id}')">Lead replies</button></div>
    <div class="row"><button class="small ghost" onclick="stage('${l.id}','won')">Mark won</button><button class="small ghost" onclick="stage('${l.id}','lost')">Mark lost</button></div>` : ""}
    <h4>Audit trail</h4>
    <div class="tl">${(l.timeline || []).map((t) => `<div><b>${esc(t.action)}</b>${esc(t.detail)} <small>${ago(t.at)}</small></div>`).join("")}</div>`;
  $("#drawer").hidden = false;
};
$("#dClose").onclick = () => { $("#drawer").hidden = true; openId = null; };
window.inbound = async (id) => { const t = $("#inText").value.trim(); if (!t) return; $("#inText").value = "…"; await api(`/api/leads/${id}/inbound`, { text: t }); refresh(); };
window.approve = async (id) => { await api(`/api/leads/${id}/approve`, { body: $("#apBody").value }); refresh(); };
window.stage = async (id, s) => { await api(`/api/leads/${id}/stage`, { stage: s }); refresh(); };
$("#reset").onclick = async () => { if (confirm("Clear all demo data?")) { await api("/api/reset", {}); openId = null; $("#drawer").hidden = true; refresh(); } };

$("#form").onsubmit = async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  $("#formMsg").textContent = "Qualifying…";
  const r = await api("/api/leads", body);
  $("#formMsg").textContent = r.ok ? (r.duplicate ? "Same person already in the pipeline — merged, no second reply." : `Done: ${r.lead.qualification?.tier || r.lead.stage}${r.lead.responseSeconds != null ? `, replied in ${r.lead.responseSeconds}s` : ""}`) : r.error;
  if (r.ok) e.target.reset();
  refresh();
};

new EventSource("/api/events").onmessage = () => refresh();
refresh();
