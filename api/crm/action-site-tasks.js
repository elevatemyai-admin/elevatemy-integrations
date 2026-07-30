// Bidirectional sync endpoint for client action-plan sites (e.g.
// devon-action-plan.vercel.app, alpine-action-plan.vercel.app) — these are
// SEPARATE Vercel projects, each with its own hardcoded roadmap steps in
// their own source code. This endpoint is what lets a specific client's
// step completion live in the CRM instead of that site's own browser
// localStorage, which is what it was doing before (meaning "sync" wasn't
// actually happening anywhere — each browser had its own private copy).
//
// Each action-plan site's CLIENT config needs a `crmEmail` field matching
// a real CRM client's email — that's the join key connecting a specific
// deployed site to a specific CRM client record.
//
// Every step is matched to a CRM task via a stable `actionSiteStepKey`
// field stored on the task record (NOT by array position — that could
// silently break if a site's ROADMAP array is ever reordered/edited).
//
// GET  ?email=...              -> { steps: [{ stepKey, title, done, assigneeName, notes }] }
// POST { email, steps: [...], event?: { type: 'chat_message_sent' | 'voice_input_used' } }
//   -> upserts each step into that client's tasks array; a newly-completed
//      step (transitioning pending -> done) logs an activity entry; an
//      optional `event` logs its own lightweight activity entry and, for
//      voice_input_used, increments a running per-client counter
//      (client.actionSiteVoiceCount) — this is a USAGE COUNT ONLY, no
//      actual audio is recorded or stored anywhere.
//
// Deliberately public/unauthenticated, same as api/crm/data.js — these
// action-plan sites are separate client-facing projects with no shared
// auth mechanism with the CRM yet. Scoped tightly to one client's record
// per call (via email) rather than exposing the whole database, as a
// partial mitigation given there's no real auth here.

const { getCache, setCache } = require("../../lib/store");
const crypto = require("crypto");

const CRM_DATA_KEY = "crm:data";

function clientLabel(client) {
  return client.name || client.company || client.email || "A client";
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // called cross-origin from separate action-plan-site domains
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const crmData = (await getCache(CRM_DATA_KEY, null)) || {};
    const clients = crmData.clients || [];

    if (req.method === "GET") {
      const email = (req.query.email || "").toLowerCase().trim();
      if (!email) return res.status(400).json({ error: "email is required" });
      const client = clients.find((c) => (c.email || "").toLowerCase().trim() === email);
      if (!client) return res.status(404).json({ error: "No client found with that email" });

      const steps = (client.tasks || [])
        .filter((t) => t.actionSiteStepKey)
        .map((t) => ({
          stepKey: t.actionSiteStepKey,
          title: t.title,
          done: t.status === "done",
          assigneeName: t.actionSiteAssigneeName || "",
          notes: t.actionSiteNotes || "",
        }));
      return res.status(200).json({ steps });
    }

    if (req.method === "POST") {
      const { email, steps, event } = req.body || {};
      const cleanEmail = (email || "").toLowerCase().trim();
      if (!cleanEmail) return res.status(400).json({ error: "email is required" });
      if (!Array.isArray(steps)) return res.status(400).json({ error: "steps array is required" });

      const idx = clients.findIndex((c) => (c.email || "").toLowerCase().trim() === cleanEmail);
      if (idx === -1) return res.status(404).json({ error: "No client found with that email" });

      const client = clients[idx];
      const updatedTasks = [...(client.tasks || [])];
      const newActivityEntries = [];

      for (const step of steps) {
        if (!step.stepKey) continue;
        const taskIdx = updatedTasks.findIndex((t) => t.actionSiteStepKey === step.stepKey);
        const wasDone = taskIdx !== -1 && updatedTasks[taskIdx].status === "done";
        const patch = {
          actionSiteStepKey: step.stepKey,
          title: step.title || (taskIdx !== -1 ? updatedTasks[taskIdx].title : step.stepKey),
          status: step.done ? "done" : "pending",
          owner: "client", // action-site steps are inherently client-facing work-in-progress items
          actionSiteAssigneeName: step.assigneeName || "",
          actionSiteNotes: step.notes || "",
        };
        if (taskIdx !== -1) {
          updatedTasks[taskIdx] = { ...updatedTasks[taskIdx], ...patch };
        } else {
          updatedTasks.push({ id: crypto.randomBytes(6).toString("hex"), dueDate: "", assignedTo: null, blockStart: "", blockEnd: "", ...patch });
        }
        // Only log a fresh completion, not every sync call (which fires
        // on every save regardless of whether anything actually changed).
        if (step.done && !wasDone) {
          newActivityEntries.push(`${clientLabel(client)} completed "${patch.title}" on their action site`);
        }
      }

      let voiceCount = client.actionSiteVoiceCount || 0;
      if (event && event.type === "voice_input_used") {
        voiceCount += 1;
        newActivityEntries.push(`${clientLabel(client)} used voice input on their action site`);
      } else if (event && event.type === "chat_message_sent") {
        newActivityEntries.push(`${clientLabel(client)} sent a message via their action site chat`);
      }

      clients[idx] = { ...client, tasks: updatedTasks, actionSiteVoiceCount: voiceCount };
      crmData.clients = clients;

      if (newActivityEntries.length) {
        const entries = newActivityEntries.map((text) => ({ id: crypto.randomBytes(4).toString("hex"), text, ts: new Date().toISOString() }));
        crmData.activityLog = [...entries, ...(crmData.activityLog || [])].slice(0, 300);
      }

      await setCache(CRM_DATA_KEY, crmData);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    console.error("[crm/action-site-tasks] failed:", e.message);
    res.status(500).json({ error: e.message });
  }
};
