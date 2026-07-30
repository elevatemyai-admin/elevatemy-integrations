// lib/guardrails.js
//
// Circuit breakers that any autonomous send/replenish job should check
// BEFORE taking action. The goal: a bad batch (high bounce rate, any real
// spam complaints) auto-pauses the campaign and alerts a human, rather than
// quietly repeating the ~26% bounce event at larger scale next time.
//
// Thresholds are conservative on purpose — better to pause and have a human
// clear a false alarm than to keep sending through a real problem.

const { getCache, setCache } = require("./store");

const PAUSE_FLAG_KEY = "campaign:cpaPaused";

const THRESHOLDS = {
  maxBounceRate: 0.05,      // 5% — well above normal, well below the ~26% event
  maxComplaintRate: 0.001,  // 0.1% — complaints matter more than bounces for account risk
  maxBatchGrowth: 750,      // don't let one replenishment cycle add more than this many contacts
};

// Call this after pulling fresh stats for any send. Returns whether it's
// safe to keep going, and why not if it isn't.
function checkCampaignHealth({ sent, delivered, bounced, complaints }) {
  const reasons = [];
  const bounceRate = sent > 0 ? bounced / sent : 0;
  const complaintRate = delivered > 0 ? complaints / delivered : 0;

  if (bounceRate > THRESHOLDS.maxBounceRate) {
    reasons.push(`Bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds ${(THRESHOLDS.maxBounceRate * 100)}% threshold`);
  }
  if (complaintRate > THRESHOLDS.maxComplaintRate) {
    reasons.push(`Complaint rate ${(complaintRate * 100).toFixed(3)}% exceeds ${(THRESHOLDS.maxComplaintRate * 100)}% threshold`);
  }

  return { ok: reasons.length === 0, reasons, bounceRate, complaintRate };
}

// Caps how many new contacts a single replenishment cycle is allowed to add,
// regardless of how big the computed deficit is — prevents an autonomous job
// from ever deciding on its own to jump from 1,200 contacts to 10,000+ in one
// run, even if the math would technically allow it.
function capBatchSize(requestedSize) {
  return Math.min(requestedSize, THRESHOLDS.maxBatchGrowth);
}

// Persists a pause — any autonomous job (list-health, content-refresh, etc.)
// should check isPaused() before taking action, not just at the moment a
// breaker trips.
async function pauseCampaign(reason) {
  await setCache(PAUSE_FLAG_KEY, { paused: true, reason, pausedAt: new Date().toISOString() });
  console.error(`[guardrails] CAMPAIGN PAUSED: ${reason}`);
  // Hook your alerting here (Pushover, Slack webhook, etc.) — a paused
  // campaign that nobody notices for a week defeats the purpose of pausing.
}

async function isPaused() {
  const state = await getCache(PAUSE_FLAG_KEY, { paused: false });
  return state.paused === true ? state : false;
}

async function resumeCampaign() {
  await setCache(PAUSE_FLAG_KEY, { paused: false });
}

module.exports = {
  checkCampaignHealth,
  capBatchSize,
  pauseCampaign,
  isPaused,
  resumeCampaign,
  THRESHOLDS,
};
