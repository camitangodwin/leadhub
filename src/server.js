import "dotenv/config";
import path from "node:path";
import express from "express";
import * as store from "./db.js";
import * as P from "./pipeline.js";
import { aiEnabled, BIZ } from "./ai.js";

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(store.ROOT, "public")));

const wrap = (fn) => async (req, res) => {
  try { const r = await fn(req); res.status(r?.status || (r?.ok === false ? 400 : 200)).json(r); }
  catch (e) { console.error(e); res.status(500).json({ ok: false, error: e.message }); }
};

// Intake: web form and a webhook endpoint (e.g. from Facebook Lead Ads / Zapier / n8n)
app.post("/api/leads", wrap((req) => P.intake(req.body, "form:" + req.ip)));
app.post("/api/webhook/lead", wrap((req) => P.intake({ ...req.body, source: req.body.source || "webhook" }, "webhook:" + req.ip)));
app.post("/api/leads/:id/inbound", wrap((req) => P.inbound(req.params.id, String(req.body.text || ""))));
app.post("/api/leads/:id/approve", wrap((req) => P.approve(req.params.id, req.body)));
app.post("/api/leads/:id/stage", wrap((req) => P.setStage(req.params.id, req.body.stage)));
app.get("/api/state", (req, res) => {
  const d = store.get();
  res.json({
    business: BIZ.name, ai: aiEnabled() ? "Claude" : "rules (no API key)", approval: process.env.REQUIRE_APPROVAL === "true",
    speed: Number(process.env.TIME_SPEED || 1), stats: P.stats(),
    leads: Object.values(d.leads).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    alerts: d.alerts.slice(0, 20), outbox: d.outbox.slice(-30).reverse(),
  });
});
app.post("/api/reset", wrap(() => { store.reset(); P.bus.emit("change"); return { ok: true }; }));

// Live updates for the dashboard
app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const on = () => res.write("data: change\n\n");
  P.bus.on("change", on);
  req.on("close", () => P.bus.off("change", on));
});

setInterval(() => P.tick(), 5000);
const port = Number(process.env.PORT || 7788);
app.listen(port, "127.0.0.1", () => console.log(`LeadHub → http://localhost:${port}  (AI: ${aiEnabled() ? "Claude" : "rules fallback"}, time x${process.env.TIME_SPEED || 1})`));
