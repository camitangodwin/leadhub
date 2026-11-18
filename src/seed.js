// Sends a realistic mix of demo leads to a running LeadHub (npm start first, then npm run demo).
const BASE = `http://localhost:${process.env.PORT || 7788}`;
const LEADS = [
  { name: "Daniel Tan", email: "daniel.tan@example.com", phone: "9123 4567", source: "Website form", message: "Hi, we want to sell our 4-room HDB in Tampines within the next month. Can someone do a valuation this week?" },
  { name: "Priya Nair", email: "priya.n@example.com", source: "Facebook Lead Ad", message: "Looking for a 3-bedroom condo in Bishan, budget around $1.6M, loan in-principle approved. Can we arrange a viewing this weekend?" },
  { name: "Marcus Lee", email: "marcus.lee@example.com", source: "Website form", message: "Just exploring. Maybe buying next year, what areas do you cover?" },
  { name: "Aisha Rahman", phone: "8765 4321", source: "WhatsApp click-to-chat", message: "Hello, I need a 2 bedroom rental near Jurong East, moving in 3 weeks." },
  { name: "Growth Agency", email: "sales@seo-boost.example", source: "Website form", message: "We can help your business rank #1! SEO services and backlinks at a discount, reply now." },
  { name: "Kevin Ong", email: "kevin.ong@example.com", source: "Website form", message: "Do you handle office space for rent in the CBD? Need 2,000 sqft." },
  { name: "Daniel Tan", email: "Daniel.Tan@example.com", source: "Instagram", message: "Following up on my Tampines flat — any update?" },
  { name: "Grace Lim", email: "grace.lim@example.com", source: "Website form", message: "Thinking of renting out my Punggol unit later this year, what do you charge?" },
];
for (const l of LEADS) {
  const r = await fetch(BASE + "/api/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(l) }).then((x) => x.json());
  const q = r.lead?.qualification;
  console.log(`${(r.duplicate ? "DUPLICATE" : r.lead?.stage || r.error).padEnd(16)} ${l.name.padEnd(14)} ${q ? `${q.tier} ${q.score} → ${q.next_action}` : ""}`);
}
console.log(`\nOpen ${BASE} to see the pipeline. Try replying as a lead, or reply "STOP".`);
