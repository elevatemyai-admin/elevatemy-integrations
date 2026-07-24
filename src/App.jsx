import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  LayoutDashboard, Users, ListChecks, Plus, Search, X, ExternalLink, Github, Rocket,
  Newspaper, Share2, ClipboardCheck, CheckCircle2, Circle, AlertTriangle, Trash2,
  ChevronRight, ChevronDown, Save, Loader2, Calendar, Clock, History, Mail, User, Users2, DollarSign, Megaphone,
  Settings as SettingsIcon, RefreshCw, Wifi, WifiOff, TrendingUp, CreditCard, Activity,
  Inbox, UserPlus, Check, Send, FileSignature, Eye, EyeOff, Sparkles, Linkedin, Facebook, Copy, Link2, Globe, Download
} from "lucide-react";

// ---------- constants ----------

const STAGES = [
  { key: "assessment", label: "Assessment", icon: ClipboardCheck },
  { key: "newsletter", label: "Newsletter", icon: Newspaper },
  { key: "zoho", label: "Zoho Campaign", icon: Rocket },
  { key: "social", label: "Social", icon: Share2 },
  { key: "dashboard", label: "Client Dashboard", icon: Github },
];

const FIN_CATEGORIES = [
  { key: "profile", label: "Practice Profile" },
  { key: "tech", label: "Technology & Data" },
  { key: "ops", label: "Operations & Admin" },
  { key: "marketing", label: "Marketing & Growth" },
  { key: "ai", label: "AI Readiness" },
];
// Matches the real General Business assessment's 5 actual dimensions —
// same keys used in the live assessment's results URL (bf/dt/oa/cg/air).
// Previously this used generic placeholder names (Strategy/Data/People/
// Usage/Risk) that didn't correspond to anything the real assessment
// measures, so imported/real scores had nowhere correct to go.
const GEN_CATEGORIES = [
  { key: "bf", label: "Business Foundations" },
  { key: "dt", label: "Data & Technology" },
  { key: "oa", label: "Operations & Automation" },
  { key: "cg", label: "Customer & Growth" },
  { key: "air", label: "AI Readiness" },
];

const STORAGE_KEY = "elevatemy-crm-data-v2";
const API_BASE = "/api"; // same-origin now — no configuration needed
const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);
const monthKey = (iso) => (iso || "").slice(0, 7);

// External sources the CRM will pull new people from once each API route exists.
// Each expects GET {apiBaseUrl}{path} -> an array (or { items: [...] }) of records
// shaped roughly like { id, name, email, phone, company, ...sourceSpecificFields }.
const SOURCES = [
  { key: "assessments", label: "Assessment takers", path: "/hubspot/assessments", system: "HubSpot", icon: ClipboardCheck },
  { key: "cpaLeads", label: "CPA campaign responders", path: "/zoho/leads/cpa", system: "Zoho Campaigns", icon: Megaphone },
  { key: "socialLeads", label: "Social campaign leads", path: "/zoho/leads/social", system: "Zoho Campaigns", icon: Share2 },
  { key: "campaignClickers", label: "Campaign clickers", path: "/zoho/leads/clicked", system: "Zoho Campaigns", icon: Rocket },
  { key: "subscribers", label: "Newsletter subscribers", path: "/beehiiv/subscribers", system: "Beehiiv", icon: Newspaper },
];


const emptyAssessment = () => ({
  path: "general", // 'general' | 'financial'
  completed: false,
  date: "",
  categories: {}, // key -> 0-100
  overallScore: null,
  tier: "", // explicit tier if known (e.g. pulled from HubSpot) — overrides the computed one below
  grade: "",
  topOpportunity: "",
  deliveryModel: "",
  consultationBooked: false,
  consultationDate: "",
  notes: "",
});

const emptyContract = () => ({
  legalName: "",
  entityType: "",
  address: "",
  sameAsContact: false,
  signerName: "",
  signerTitle: "",
  signerEmail: "",
  billingContactName: "",
  billingContactEmail: "",
  package: "",
  effectiveDate: "",
  termLength: "",
  autoRenew: false,
  scopeNotes: "",
  feeAmount: "",
  feeFrequency: "monthly",
  paymentTerms: "",
  status: "draft", // draft | sent | signed | expired
  signatureLink: "",
  signedDate: "",
  signedDocLink: "",
  // Placeholders for the future Stripe connection — left blank until that
  // integration exists. Once built, these can be populated automatically
  // instead of pasted in by hand.
  stripeCustomerId: "",
  stripeSubscriptionId: "",
  stripeCheckoutLink: "",
});

const emptyClient = () => ({
  id: uid(),
  name: "",
  firstName: "",
  lastName: "",
  company: "",
  website: "",
  email: "",
  phone: "",
  status: "lead",
  tags: [],
  hidden: false,
  proBono: false,
  createdAt: new Date().toISOString(),
  assessment: emptyAssessment(),
  newsletter: { subscribed: false, link: "" },
  zoho: { link: "", status: "not started", lastSent: "" },
  engagementHistory: [],
  social: [],
  dashboard: { vercelUrl: "", githubUrl: "", lastInterview: "", notes: "" },
  tasks: [],
  billing: [], // { id, date, description, amount, status, method, stripeLink }
  contract: emptyContract(),
});

const emptyCampaign = () => ({
  id: uid(), name: "", platform: "Zoho CPA", spend: "", leads: "", status: "active", link: "", source: "manual",
});

function gradeForScore(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return "";
  if (pct >= 80) return "AI-Ready";
  if (pct >= 60) return "Emerging";
  if (pct >= 40) return "Building";
  return "Exploring";
}

function categoriesFor(path) { return path === "financial" ? FIN_CATEGORIES : GEN_CATEGORIES; }

function computeOverall(assessment) {
  const cats = categoriesFor(assessment.path);
  const vals = cats.map(c => Number(assessment.categories?.[c.key])).filter(v => !isNaN(v) && v !== null);
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function stageComplete(client, key) {
  switch (key) {
    case "assessment": return !!client.assessment?.completed;
    case "newsletter": return !!client.newsletter?.subscribed;
    case "zoho": return client.zoho?.status === "active" || client.zoho?.status === "completed";
    case "social": return (client.social || []).some(s => s.status === "active" || s.status === "completed");
    case "dashboard": return !!(client.dashboard?.vercelUrl || client.dashboard?.githubUrl);
    default: return false;
  }
}
function isOverdue(task) {
  if (task.status === "done" || !task.dueDate) return false;
  return new Date(task.dueDate + "T23:59:59") < new Date();
}
// Many auto-imported clients (esp. from Beehiiv) have no name on file at
// all — fall back to company, then email, before ever showing "Unnamed
// client", since a bare email is far more useful/identifying than nothing.
function clientDisplayName(c) { return (c && (c.name || c.company || c.email)) || "Unnamed client"; }

// Payment-status pills, computed live from billing entries + the manual
// pro-bono flag — not stored separately, so they're always accurate.
// "Payment Due" is suppressed for pro-bono clients even if nothing's been
// logged, since no payment is expected from them in the first place.
function paymentPills(c) {
  const entries = c.billing || [];
  const hasPaid = entries.some(e => e.status === "paid");
  const hasDue = entries.some(e => e.status === "pending" || e.status === "overdue") && !c.proBono;
  return { hasPaid, hasDue, isProBono: !!c.proBono };
}

// True once a client has completed the Financial Services assessment track
// (as opposed to the General Business track) — computed live from the
// assessment record, not stored separately.
function isFpLead(c) { return !!(c.assessment?.completed && c.assessment?.path === "financial"); }

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso + (iso.length === 10 ? "T00:00:00" : "")).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return iso; }
}
function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ---------- small UI atoms ----------

function AscentPath({ client, size = "sm" }) {
  const dim = size === "sm" ? 9 : 13;
  return (
    <div className="ascent-path" title="Journey progress">
      {STAGES.map((s, i) => {
        const done = stageComplete(client, s.key);
        return (
          <React.Fragment key={s.key}>
            <div className={"ascent-dot" + (done ? " ascent-dot-done" : "")} style={{ width: dim, height: dim }} title={s.label + (done ? " — complete" : " — pending")} />
            {i < STAGES.length - 1 && <div className={"ascent-line" + (done ? " ascent-line-done" : "")} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}
function Pill({ children, tone = "slate" }) { return <span className={`pill pill-${tone}`}>{children}</span>; }
function StatCard({ label, value, icon: Icon, tone, sub }) {
  return (
    <div className="stat-card">
      <div className={`stat-icon stat-icon-${tone}`}><Icon size={18} /></div>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
        {sub && <div className="stat-sub">{sub}</div>}
      </div>
    </div>
  );
}
function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

// ---------- main app ----------

export default function App() {
  const [clients, setClients] = useState([]);
  const [marketingCampaigns, setMarketingCampaigns] = useState([]);
  const [activityLog, setActivityLog] = useState([]);
  const [team, setTeam] = useState([]);
  const [emailTemplates, setEmailTemplates] = useState([]);
  const [pendingEmails, setPendingEmails] = useState([]);
  const [marketingHub, setMarketingHub] = useState({ campaigns: [], contentItems: [] });
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle");

  const [view, setView] = useState("overview");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showHidden, setShowHidden] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [detailTab, setDetailTab] = useState("profile");
  const [showAddModal, setShowAddModal] = useState(false);
  const [emailComposerClient, setEmailComposerClient] = useState(null);
  const [taskOwnerFilter, setTaskOwnerFilter] = useState("all");
  const [taskAssigneeFilter, setTaskAssigneeFilter] = useState("all");

  const [zohoLive, setZohoLive] = useState([]);
  const [zohoStatus, setZohoStatus] = useState("unconfigured"); // unconfigured | checking | live | error
  const [zohoError, setZohoError] = useState("");
  const [sourceData, setSourceData] = useState(() => Object.fromEntries(SOURCES.map(s => [s.key, { status: "unconfigured", items: [] }])));

  const loadCrmData = useCallback(async () => {
    try {
      const res = await fetch("/api/crm/data");
      const parsed = await res.json();
      if (parsed) {
        setClients((parsed.clients || []).map(c => {
          const hasSplitName = c.firstName || c.lastName;
          const nameParts = (c.name || "").trim().split(/\s+/).filter(Boolean);
          const backfilledFirst = hasSplitName ? (c.firstName || "") : (nameParts[0] || "");
          const backfilledLast = hasSplitName ? (c.lastName || "") : nameParts.slice(1).join(" ");
          return {
            ...emptyClient(), ...c,
            firstName: backfilledFirst,
            lastName: backfilledLast,
            assessment: { ...emptyAssessment(), ...(c.assessment || {}) },
            contract: { ...emptyContract(), ...(c.contract || {}) },
          };
        }));
        setMarketingCampaigns(parsed.marketingCampaigns || []);
        setActivityLog(parsed.activityLog || []);
        setTeam(parsed.team || []);
        setEmailTemplates(parsed.emailTemplates || []);
        setPendingEmails(parsed.pendingEmails || []);
        setMarketingHub(parsed.marketingHub || { campaigns: [], contentItems: [] });
      }
    } catch (e) { /* first run — nothing stored yet, or a refresh failed silently */ }
  }, []);

  useEffect(() => {
    (async () => {
      await loadCrmData();
      setLoading(false);
    })();
  }, [loadCrmData]);

  const persist = useCallback(async (next) => {
    setSaveState("saving");
    try {
      // The CRM's save endpoint overwrites the whole stored blob rather
      // than merging (see api/crm/data.js) — fine for fields this app
      // owns (clients, tasks, etc.), but settings.gmailLastSyncTs,
      // pendingEmails, and marketingHub are written by the daily sync job /
      // AI drafting and approval steps running server-side, not by
      // anything in this browser tab.
      // Fetching the current server state right before writing (instead
      // of trusting whatever this tab loaded at page-open) closes almost
      // all of the window where a save from this tab could otherwise
      // silently wipe out a backend-written field with stale data.
      let serverOwned = {};
      try {
        const current = await fetch("/api/crm/data").then(r => r.json());
        serverOwned = { settings: current?.settings, pendingEmails: current?.pendingEmails, marketingHub: current?.marketingHub };
      } catch (e) { /* if this fails, fall through and save without them rather than blocking the save entirely */ }

      const res = await fetch("/api/crm/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...serverOwned, ...next }),
      });
      setSaveState(res.ok ? "saved" : "error");
    } catch (e) { setSaveState("error"); }
    setTimeout(() => setSaveState(s => s === "saving" ? s : "idle"), 1400);
  }, []);

  const snapshot = useCallback((overrides = {}) => ({
    clients, marketingCampaigns, activityLog, team, emailTemplates, ...overrides,
  }), [clients, marketingCampaigns, activityLog, team, emailTemplates]);

  function logActivity(text, list = activityLog) {
    const entry = { id: uid(), text, ts: new Date().toISOString() };
    return [entry, ...list].slice(0, 50);
  }

  function updateClients(updater, activityText) {
    setClients(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const nextLog = activityText ? logActivity(activityText) : activityLog;
      if (activityText) setActivityLog(nextLog);
      persist(snapshot({ clients: next, activityLog: nextLog }));
      return next;
    });
  }
  function updateCampaigns(updater, activityText) {
    setMarketingCampaigns(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const nextLog = activityText ? logActivity(activityText) : activityLog;
      if (activityText) setActivityLog(nextLog);
      persist(snapshot({ marketingCampaigns: next, activityLog: nextLog }));
      return next;
    });
  }
  function updateEmailTemplates(updater) {
    setEmailTemplates(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      persist(snapshot({ emailTemplates: next }));
      return next;
    });
  }
  function addEmailTemplate(t) { updateEmailTemplates(prev => [{ id: uid(), ...t }, ...prev]); }
  function removeEmailTemplate(id) { updateEmailTemplates(prev => prev.filter(t => t.id !== id)); }
  function patchEmailTemplate(id, patch) { updateEmailTemplates(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t)); }

  async function approvePendingEmail(id, action, edits) {
    try {
      const res = await fetch("/api/gmail/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingEmailId: id, action, editedSubject: edits?.subject, editedBody: edits?.body }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed");
      await loadCrmData();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function createMarketingCampaign(data) {
    try {
      const res = await fetch("/api/marketing/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || "Failed");
      await loadCrmData();
      return { ok: true, campaign: result.campaign };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function generateMarketingContent({ campaignId, type, brief, targetTier }) {
    try {
      const res = await fetch("/api/marketing/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, type, brief, targetTier }),
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || "Generation failed");
      await loadCrmData();
      return { ok: true, item: result.item };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function approveMarketingContent(itemId, action, edits, extra) {
    try {
      const res = await fetch("/api/marketing/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId, action,
          editedSubject: edits?.subject, editedBody: edits?.body,
          targetTier: extra?.targetTier, scheduledFor: extra?.scheduledFor,
        }),
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || "Failed");
      await loadCrmData();
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function generateBrandedImage(itemId) {
    try {
      const res = await fetch("/api/marketing/design-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || "Image generation failed");
      await loadCrmData();
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  const selectedClient = useMemo(() => clients.find(c => c.id === selectedId) || null, [clients, selectedId]);

  const filteredClients = useMemo(() => clients.filter(c => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (!showHidden && !search.trim() && c.hidden) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return [c.name, c.company, c.email].some(v => (v || "").toLowerCase().includes(q));
  }), [clients, search, statusFilter, showHidden]);

  const allTasks = useMemo(() => {
    const list = [];
    clients.forEach(c => (c.tasks || []).forEach(t => list.push({ ...t, clientId: c.id, clientName: clientDisplayName(c) })));
    return list;
  }, [clients]);

  const overdueCount = useMemo(() => allTasks.filter(isOverdue).length, [allTasks]);
  const assessedCount = useMemo(() => clients.filter(c => c.assessment?.completed).length, [clients]);
  const activeCampaignCount = useMemo(() => clients.filter(c => c.zoho?.status === "active").length, [clients]);

  const revenue = useMemo(() => {
    const thisMonth = monthKey(todayISO());
    let total = 0, mtd = 0, pending = 0;
    clients.forEach(c => (c.billing || []).forEach(b => {
      const amt = Number(b.amount) || 0;
      if (b.status === "paid") { total += amt; if (monthKey(b.date) === thisMonth) mtd += amt; }
      else pending += amt;
    }));
    return { total, mtd, pending };
  }, [clients]);

  // -- client mutators --
  function patchClient(id, patch, activityText) { updateClients(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c), activityText); }
  function patchNested(id, section, patch) { updateClients(prev => prev.map(c => c.id === id ? { ...c, [section]: { ...c[section], ...patch } } : c)); }
  function addClient(data) {
    const c = { ...emptyClient(), ...data };
    updateClients(prev => [c, ...prev], `Added client ${c.name || "Unnamed"}`);
    setSelectedId(c.id); setView("clients"); setDetailTab("profile");
  }
  function deleteClient(id) {
    const c = clients.find(x => x.id === id);
    updateClients(prev => prev.filter(x => x.id !== id), c ? `Removed client ${c.name || "Unnamed"}` : undefined);
    if (selectedId === id) setSelectedId(null);
  }
  function addSocial(id) { updateClients(prev => prev.map(c => c.id === id ? { ...c, social: [...(c.social || []), { id: uid(), platform: "Instagram", link: "", status: "not started" }] } : c)); }
  function patchSocial(id, sid, patch) { updateClients(prev => prev.map(c => c.id === id ? { ...c, social: c.social.map(s => s.id === sid ? { ...s, ...patch } : s) } : c)); }
  function removeSocial(id, sid) { updateClients(prev => prev.map(c => c.id === id ? { ...c, social: c.social.filter(s => s.id !== sid) } : c)); }
  function addTask(id, task) { updateClients(prev => prev.map(c => c.id === id ? { ...c, tasks: [...(c.tasks || []), { id: uid(), status: "pending", ...task }] } : c)); }
  function toggleTask(id, taskId) {
    const c = clients.find(x => x.id === id);
    const t = c?.tasks.find(x => x.id === taskId);
    const willComplete = t && t.status !== "done";
    updateClients(prev => prev.map(x => x.id === id ? { ...x, tasks: x.tasks.map(tk => tk.id === taskId ? { ...tk, status: tk.status === "done" ? "pending" : "done" } : tk) } : x),
      willComplete && t ? `Completed task "${t.title}" for ${c.name || "client"}` : undefined);
  }
  function removeTask(id, taskId) { updateClients(prev => prev.map(c => c.id === id ? { ...c, tasks: c.tasks.filter(t => t.id !== taskId) } : c)); }
  function patchTask(id, taskId, patch) { updateClients(prev => prev.map(c => c.id === id ? { ...c, tasks: c.tasks.map(t => t.id === taskId ? { ...t, ...patch } : t) } : c)); }
  function addBilling(id, entry) {
    const c = clients.find(x => x.id === id);
    updateClients(prev => prev.map(x => x.id === id ? { ...x, billing: [{ id: uid(), ...entry }, ...(x.billing || [])] } : x),
      `Logged ${fmtMoney(entry.amount)} (${entry.status}) for ${c?.name || "client"}`);
  }
  function patchBilling(id, bid, patch) { updateClients(prev => prev.map(c => c.id === id ? { ...c, billing: c.billing.map(b => b.id === bid ? { ...b, ...patch } : b) } : c)); }
  function removeBilling(id, bid) { updateClients(prev => prev.map(c => c.id === id ? { ...c, billing: c.billing.filter(b => b.id !== bid) } : c)); }

  function addCampaign(data) { updateCampaigns(prev => [{ ...emptyCampaign(), ...data }, ...prev], `Added marketing campaign "${data.name}"`); }
  function patchCampaign(id, patch) { updateCampaigns(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c)); }
  function removeCampaign(id) { updateCampaigns(prev => prev.filter(c => c.id !== id)); }

  function updateTeam(updater, activityText) {
    setTeam(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const nextLog = activityText ? logActivity(activityText) : activityLog;
      if (activityText) setActivityLog(nextLog);
      persist(snapshot({ team: next, activityLog: nextLog }));
      return next;
    });
  }
  function addTeamMember(data) {
    const m = { id: uid(), name: "", email: "", role: "", ...data };
    updateTeam(prev => [...prev, m], `Added ${m.name || "a team member"} to the team`);
  }
  function removeTeamMember(id) {
    const m = team.find(t => t.id === id);
    updateTeam(prev => prev.filter(t => t.id !== id), m ? `Removed ${m.name || "a team member"} from the team` : undefined);
  }

  // -- Zoho live check --
  const checkZoho = useCallback(async () => {
    setZohoStatus("checking");
    setZohoError("");
    try {
      const res = await fetch(`${API_BASE}/zoho/campaigns`);
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const errBody = await res.json(); if (errBody?.error) detail = errBody.error; } catch (_) { /* body wasn't JSON */ }
        throw new Error(detail);
      }
      const data = await res.json();
      setZohoLive(Array.isArray(data) ? data : (data.items || data.campaigns || []));
      setZohoStatus("live");
    } catch (e) {
      setZohoStatus("error");
      setZohoLive([]);
      setZohoError(e.message || String(e));
    }
  }, []);

  useEffect(() => { checkZoho(); }, [checkZoho]);

  const checkSources = useCallback(async () => {
    setSourceData(prev => Object.fromEntries(SOURCES.map(s => [s.key, { ...prev[s.key], status: "checking" }])));
    const results = await Promise.allSettled(SOURCES.map(async (s) => {
      const res = await fetch(`${API_BASE}${s.path}`);
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      return Array.isArray(data) ? data : (data.items || data.records || []);
    }));
    setSourceData(() => {
      const next = {};
      results.forEach((r, i) => {
        const key = SOURCES[i].key;
        next[key] = r.status === "fulfilled" ? { status: "live", items: r.value } : { status: "error", items: [] };
      });
      return next;
    });
  }, []);

  useEffect(() => { checkSources(); }, [checkSources]);

  function findClientByEmail(email) {
    if (!email) return null;
    const e = email.toLowerCase().trim();
    return clients.find(c => (c.email || "").toLowerCase().trim() === e) || null;
  }

  function addFromCandidate(candidate, sourceKey) {
    const existing = findClientByEmail(candidate.email);
    const base = existing ? existing : emptyClient();
    const patch = {
      name: base.name || candidate.name || "",
      company: base.company || candidate.company || "",
      email: base.email || candidate.email || "",
      phone: base.phone || candidate.phone || "",
      status: base.status === "lead" || !existing ? "lead" : base.status,
    };
    if (sourceKey === "assessments") {
      patch.assessment = {
        ...emptyAssessment(),
        ...base.assessment,
        path: candidate.path === "financial" ? "financial" : (candidate.path === "general" ? "general" : (base.assessment?.path || "general")),
        completed: true,
        date: candidate.completedAt ? candidate.completedAt.slice(0, 10) : (base.assessment?.date || todayISO()),
        categories: candidate.categories || base.assessment?.categories || {},
        overallScore: candidate.overallScore ?? base.assessment?.overallScore ?? null,
        tier: candidate.tier || base.assessment?.tier || "",
        topOpportunity: candidate.topOpportunity || base.assessment?.topOpportunity || "",
        deliveryModel: candidate.deliveryModel || base.assessment?.deliveryModel || "",
      };
    } else if (sourceKey === "subscribers") {
      patch.newsletter = { ...base.newsletter, subscribed: true, link: base.newsletter?.link || candidate.link || "" };
    } else if (sourceKey === "cpaLeads") {
      patch.zoho = { ...base.zoho, status: base.zoho?.status === "active" ? base.zoho.status : "active", link: base.zoho?.link || candidate.campaignLink || "" };
    } else if (sourceKey === "campaignClickers") {
      patch.zoho = { ...base.zoho, status: base.zoho?.status === "active" ? base.zoho.status : "active", link: base.zoho?.link || candidate.campaignLink || "", lastSent: base.zoho?.lastSent || (candidate.clickedAt ? candidate.clickedAt.slice(0, 10) : "") };
    } else if (sourceKey === "socialLeads") {
      const already = (base.social || []).some(s => (s.platform || "").toLowerCase() === (candidate.platform || "").toLowerCase());
      patch.social = already ? base.social : [...(base.social || []), { id: uid(), platform: candidate.platform || "Social", link: candidate.campaignLink || "", status: "active" }];
    }
    if (existing) {
      updateClients(prev => prev.map(c => c.id === existing.id ? { ...c, ...patch } : c), `Merged ${SOURCES.find(s => s.key === sourceKey)?.label.toLowerCase()} data into ${patch.name || "client"}`);
    } else {
      const c = { ...emptyClient(), ...patch };
      updateClients(prev => [c, ...prev], `Added ${c.name || "Unnamed"} from ${SOURCES.find(s => s.key === sourceKey)?.label.toLowerCase()}`);
    }
  }

  function addAllNew(sourceKey) {
    const items = sourceData[sourceKey]?.items || [];
    items.filter(i => !findClientByEmail(i.email)).forEach(i => addFromCandidate(i, sourceKey));
  }


  const NAV = [
    { key: "overview", label: "Dashboard", icon: LayoutDashboard },
    { key: "clients", label: "Clients", icon: Users },
    { key: "import", label: "Import", icon: Inbox },
    { key: "tasks", label: "Tasks", icon: ListChecks },
    { key: "marketing", label: "Marketing", icon: Megaphone },
    { key: "content", label: "Content Studio", icon: Sparkles },
    { key: "actionsites", label: "Action Sites", icon: Globe },
    { key: "settings", label: "Settings", icon: SettingsIcon },
  ];

  return (
    <div className="crm-root">
      <style>{`
        .crm-root {
          // Brand colors below now come from the official elevatemy.ai Brand
          // Kit doc (uploaded July 23, 2026), verified by pixel-sampling the
          // actual logo files inside it — not approximated from screenshots
          // or emails, which is what earlier versions of this file did.
          //
          // The brand kit defines TWO variants: "Financial Services" (dark,
          // for dark surfaces) and "General Business" (light, for light
          // surfaces) — it explicitly says the GB variant "is not designed
          // for dark surfaces." Since this CRM's sidebar IS a dark surface,
          // the sidebar specifically uses the FP variant's exact colors
          // (--sidebar-*), while the main light content area uses the GB
          // variant (the --navy/--cloud/etc. tokens below). This isn't a
          // style choice — it's what the brand kit's own usage rules call
          // for given this app's actual dark/light layout.
          //
          // GB (General Business) palette — confirmed hex, light surfaces:
          --ink:#1a1a1a; --navy:#1B3A6B; --navy-soft:#3D4E8A; --cloud:#F8F6F2; --cloud-dim:#EAEBEA;
          --teal-accent:#00A99D; --pale-teal:#5BC8C0; --peach-accent:#E5C9B2;
          --card:#FFFFFF; --gold:#E8A33D; --gold-soft:#FBEBD2; --green:#4C7A5E; --green-soft:#E1EBE4;
          --coral:#C7554F; --coral-soft:#F5DEDC; --slate:#6B7280; --slate-line:#DADEE3;
          // FP (Financial Services) palette — confirmed hex, used ONLY for
          // the dark sidebar (background, hover states, wordmark, icon):
          --sidebar-bg:#0B1120; --sidebar-icon-bg:#141E30; --sidebar-bar:#3D4E8A;
          --sidebar-teal:#2DD4C8; --sidebar-text:#F1F5F9;
          font-family:'Inter',-apple-system,sans-serif; background:var(--cloud); color:var(--ink);
          min-height:100vh; display:flex; border-radius:12px; overflow:hidden;
        }
        .crm-root * { box-sizing:border-box; }
        .display { font-family:'Fraunces', Georgia, serif; }
        .sidebar { width:220px; flex-shrink:0; background:var(--sidebar-bg); color:var(--sidebar-text); display:flex; flex-direction:column; padding:20px 14px; }
        .brand { display:flex; align-items:center; gap:10px; padding:6px 8px 22px; }
        .brand-mark { width:32px; height:32px; border-radius:8px; object-fit:contain; flex-shrink:0; }
        .brand-name { font-size:16px; font-weight:700; color:var(--sidebar-text); letter-spacing:-0.01em; }
        .brand-name .ai-suffix { font-weight:400; color:var(--sidebar-teal); }
        .brand-sub { font-size:9.5px; color:#9AA5B1; margin-top:2px; text-transform:uppercase; letter-spacing:0.08em; font-weight:600; }
        .nav-item { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:8px; cursor:pointer; font-size:13.5px; color:#C3CAD3; margin-bottom:2px; border:none; background:none; width:100%; text-align:left; }
        .nav-item:hover { background:var(--navy-soft); color:#fff; }
        .nav-item.active { background:var(--navy-soft); color:#fff; box-shadow:inset 3px 0 0 var(--gold); }
        .sidebar-footer { margin-top:auto; font-size:11px; color:#7C8894; padding:10px 8px; }
        .save-indicator { display:flex; align-items:center; gap:6px; }
        .main { flex:1; display:flex; flex-direction:column; min-width:0; max-height:100vh; overflow:hidden; }
        .topbar { padding:18px 28px; border-bottom:1px solid var(--slate-line); background:var(--card); display:flex; align-items:center; justify-content:space-between; }
        .topbar h1 { font-size:20px; margin:0; }
        .topbar p { margin:2px 0 0; font-size:12.5px; color:var(--slate); }
        .content { flex:1; overflow-y:auto; padding:24px 28px 48px; }
        .btn { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:600; padding:8px 14px; border-radius:8px; border:none; cursor:pointer; }
        .btn-primary { background:var(--navy); color:#fff; }
        .btn-primary:hover { background:#0F151D; }
        .btn-gold { background:var(--gold); color:#1B2430; }
        .btn-gold:hover { background:#D6922E; }
        .btn-ghost { background:transparent; color:var(--ink); border:1px solid var(--slate-line); }
        .btn-ghost:hover { background:var(--cloud-dim); }
        .btn-danger { background:transparent; color:var(--coral); }
        .btn-sm { padding:5px 9px; font-size:12px; }
        .stat-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:24px; }
        .stat-card { background:var(--card); border:1px solid var(--slate-line); border-radius:12px; padding:16px; display:flex; align-items:center; gap:12px; }
        .stat-icon { width:36px; height:36px; border-radius:9px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .stat-icon-gold { background:var(--gold-soft); color:#966423; }
        .stat-icon-green { background:var(--green-soft); color:var(--green); }
        .stat-icon-coral { background:var(--coral-soft); color:var(--coral); }
        .stat-icon-navy { background:#E4E8ED; color:var(--navy); }
        .stat-value { font-size:20px; font-weight:700; line-height:1.1; }
        .stat-label { font-size:11.5px; color:var(--slate); margin-top:2px; }
        .stat-sub { font-size:10.5px; color:var(--slate); margin-top:2px; }
        .section-title { font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--slate); margin:4px 0 10px; display:flex; align-items:center; gap:8px; justify-content:space-between; }
        .card { background:var(--card); border:1px solid var(--slate-line); border-radius:12px; }
        .two-col { display:grid; grid-template-columns:1.3fr 1fr; gap:20px; align-items:start; }
        .ascent-path { display:flex; align-items:center; }
        .ascent-dot { border-radius:50%; background:var(--slate-line); border:2px solid var(--slate-line); flex-shrink:0; }
        .ascent-dot-done { background:var(--green); border-color:var(--green); }
        .ascent-line { width:14px; height:2px; background:var(--slate-line); }
        .ascent-line-done { background:var(--green); }
        .pill { font-size:10.5px; font-weight:700; padding:3px 8px; border-radius:20px; text-transform:capitalize; white-space:nowrap; }
        .pill-slate { background:#EDEFF2; color:#5B6470; }
        .pill-green { background:var(--green-soft); color:var(--green); }
        .pill-gold { background:var(--gold-soft); color:#966423; }
        .pill-coral { background:var(--coral-soft); color:var(--coral); }
        .pill-navy { background:#E4E8ED; color:var(--navy); }
        .pill-purple { background:#EEE7F7; color:#6B3FA0; }
        table { width:100%; border-collapse:collapse; }
        .ctable th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--slate); padding:10px 14px; border-bottom:1px solid var(--slate-line); }
        .ctable td { padding:12px 14px; border-bottom:1px solid var(--cloud-dim); font-size:13.5px; vertical-align:middle; }
        .ctable tr:last-child td { border-bottom:none; }
        .ctable tr.row-click { cursor:pointer; }
        .ctable tr.row-click:hover { background:var(--cloud); }
        .client-name { font-family:'Fraunces', Georgia, serif; font-weight:600; font-size:14.5px; }
        .client-sub { font-size:11.5px; color:var(--slate); margin-top:1px; }
        .toolbar { display:flex; align-items:center; gap:10px; margin-bottom:16px; flex-wrap:wrap; }
        .search-box { display:flex; align-items:center; gap:8px; background:var(--card); border:1px solid var(--slate-line); border-radius:8px; padding:7px 12px; flex:1; max-width:320px; }
        .search-box input { border:none; outline:none; font-size:13px; flex:1; background:transparent; }
        select.filter-select, input.filter-input { border:1px solid var(--slate-line); border-radius:8px; padding:7px 10px; font-size:13px; background:var(--card); color:var(--ink); }
        .overlay { position:fixed; inset:0; background:rgba(20,24,30,0.45); display:flex; justify-content:flex-end; z-index:50; }
        .overlay.center { align-items:center; justify-content:center; }
        .drawer { width:500px; max-width:92vw; background:var(--cloud); height:100%; overflow-y:auto; box-shadow:-8px 0 24px rgba(0,0,0,0.15); }
        .modal { width:460px; max-width:92vw; background:var(--card); border-radius:14px; padding:24px; max-height:88vh; overflow-y:auto; }
        .drawer-head { background:var(--navy); color:#fff; padding:22px 24px; display:flex; align-items:flex-start; justify-content:space-between; }
        .drawer-body { padding:18px 22px 40px; }
        .tabs { display:flex; gap:4px; border-bottom:1px solid var(--slate-line); margin-bottom:18px; padding:0 22px; background:var(--card); flex-wrap:wrap; }
        .tab { padding:10px 10px; font-size:12px; font-weight:600; color:var(--slate); cursor:pointer; border-bottom:2px solid transparent; display:flex; align-items:center; gap:5px; }
        .tab.active { color:var(--navy); border-color:var(--gold); }
        .field { display:flex; flex-direction:column; gap:5px; margin-bottom:12px; }
        .field-label { font-size:11.5px; font-weight:600; color:var(--slate); text-transform:uppercase; letter-spacing:0.03em; }
        .field-hint { font-size:11px; color:var(--slate); }
        .field input, .field select, .field textarea { border:1px solid var(--slate-line); border-radius:8px; padding:8px 10px; font-size:13.5px; font-family:inherit; background:#fff; color:var(--ink); }
        .field textarea { resize:vertical; min-height:56px; }
        .field-row { display:flex; gap:10px; }
        .field-row > .field { flex:1; }
        .empty-state { text-align:center; padding:60px 20px; color:var(--slate); }
        .empty-state .display { font-size:18px; color:var(--ink); margin-bottom:6px; }
        .task-row { display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--cloud-dim); }
        .task-row:last-child { border-bottom:none; }
        .task-check { cursor:pointer; color:var(--green); flex-shrink:0; }
        .task-title { font-size:13.5px; flex:1; }
        .task-title.done { text-decoration:line-through; color:var(--slate); }
        .task-meta { font-size:11px; color:var(--slate); display:flex; align-items:center; gap:6px; }
        .link-row { display:flex; align-items:center; gap:8px; font-size:13px; }
        .link-row a { color:var(--navy); font-weight:600; text-decoration:none; border-bottom:1px solid var(--gold); }
        .activity-row { display:flex; gap:10px; padding:9px 0; border-bottom:1px solid var(--cloud-dim); font-size:12.5px; align-items:flex-start; }
        .activity-row:last-child { border-bottom:none; }
        .activity-dot { width:6px; height:6px; border-radius:50%; background:var(--gold); margin-top:5px; flex-shrink:0; }
        .activity-time { color:var(--slate); font-size:11px; white-space:nowrap; margin-left:auto; }
        .conn-banner { display:flex; align-items:center; gap:10px; padding:12px 14px; border-radius:10px; font-size:12.5px; margin-bottom:16px; }
        .conn-live { background:var(--green-soft); color:var(--green); }
        .conn-off { background:var(--gold-soft); color:#966423; }
        .conn-error { background:var(--coral-soft); color:var(--coral); }
        .spin { animation:crm-spin 0.8s linear infinite; }
        @keyframes crm-spin { from{transform:rotate(0deg);} to{transform:rotate(360deg);} }
        .score-ring { display:flex; align-items:center; gap:14px; }
        .score-num { font-family:'Fraunces', Georgia, serif; font-size:34px; font-weight:600; }
        .cat-bar-row { margin-bottom:10px; }
        .cat-bar-label { display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px; }
        .cat-bar-track { height:7px; background:var(--cloud-dim); border-radius:4px; overflow:hidden; }
        .cat-bar-fill { height:100%; background:var(--green); border-radius:4px; }
      `}</style>

      {/* Sidebar */}
      <div className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="data:image/png;base64,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" alt="elevatemy.ai" />
          <div><div className="brand-name">elevatemy<span className="ai-suffix">.ai</span></div><div className="brand-sub">Client CRM</div></div>
        </div>
        {NAV.map(n => (
          <button key={n.key} className={"nav-item" + (view === n.key ? " active" : "")} onClick={() => setView(n.key)}>
            <n.icon size={16} /> {n.label}
          </button>
        ))}
        <div className="sidebar-footer">
          <div className="save-indicator">
            {saveState === "saving" && <><Loader2 size={12} className="spin" /> Saving…</>}
            {saveState === "saved" && <><CheckCircle2 size={12} /> Saved</>}
            {saveState === "error" && <><AlertTriangle size={12} /> Save failed</>}
            {saveState === "idle" && <>Synced to team storage</>}
          </div>
        </div>
      </div>

      {/* Main */}
      <div className="main">
        <div className="topbar">
          <div>
            <h1 className="display">
              {view === "overview" && "Dashboard"}
              {view === "clients" && "Clients"}
              {view === "import" && "Import"}
              {view === "tasks" && "Tasks & Campaigns"}
              {view === "marketing" && "Marketing"}
              {view === "content" && "Content Studio"}
              {view === "actionsites" && "Action Sites"}
              {view === "settings" && "Settings"}
            </h1>
            <p>
              {view === "overview" && "Current activity, revenue, and prospecting at a glance."}
              {view === "clients" && "Assessments, newsletter, Zoho, social, billing, and client dashboards — all in one record."}
              {view === "import" && "Pull in assessment takers, campaign responders, and subscribers from your connected systems."}
              {view === "tasks" && "What clients owe us, and what we owe clients."}
              {view === "marketing" && "CPA campaigns and prospecting activity, live from Zoho once connected."}
              {view === "content" && "AI-drafted campaigns, emails, and social posts — review and approve, nothing goes out without you."}
              {view === "actionsites" && "Every client's live action-plan site, one click away."}
              {view === "settings" && "Connect the CRM to your Vercel API routes."}
            </p>
          </div>
          {view !== "settings" && <button className="btn btn-gold" onClick={() => setShowAddModal(true)}><Plus size={15} /> Add client</button>}
        </div>

        <div className="content">
          {loading ? (
            <div className="empty-state"><Loader2 className="spin" size={20} /></div>
          ) : view === "overview" ? (
            <OverviewView
              clients={clients} revenue={revenue} activityLog={activityLog} team={team}
              pendingEmails={pendingEmails} onApprovePendingEmail={approvePendingEmail}
              assessedCount={assessedCount} activeCampaignCount={activeCampaignCount} overdueCount={overdueCount}
              marketingCampaigns={marketingCampaigns} zohoLive={zohoLive} zohoStatus={zohoStatus}
              onOpen={(id) => { setSelectedId(id); setView("clients"); setDetailTab("profile"); }}
            />
          ) : view === "clients" ? (
            <ClientsView clients={filteredClients} search={search} setSearch={setSearch} statusFilter={statusFilter} setStatusFilter={setStatusFilter}
              showHidden={showHidden} setShowHidden={setShowHidden} hiddenCount={clients.filter(c => c.hidden).length}
              apiBaseUrl={API_BASE} onToggleHidden={(id, hidden) => patchClient(id, { hidden })}
              onOpen={(id) => { setSelectedId(id); setDetailTab("profile"); }} total={clients.length} />
          ) : view === "import" ? (
            <ImportView sourceData={sourceData} onRefresh={checkSources} apiConfigured={true} activityLog={activityLog}
              findClientByEmail={findClientByEmail} onAdd={addFromCandidate} onAddAll={addAllNew} />
          ) : view === "tasks" ? (
            <TasksView tasks={allTasks} ownerFilter={taskOwnerFilter} setOwnerFilter={setTaskOwnerFilter}
              team={team} assigneeFilter={taskAssigneeFilter} setAssigneeFilter={setTaskAssigneeFilter}
              onToggle={(cid, tid) => toggleTask(cid, tid)} onOpenClient={(id) => { setSelectedId(id); setView("clients"); setDetailTab("tasks"); }} />
          ) : view === "marketing" ? (
            <MarketingView campaigns={marketingCampaigns} zohoLive={zohoLive} zohoStatus={zohoStatus} onRefresh={checkZoho}
              onAdd={addCampaign} onPatch={patchCampaign} onRemove={removeCampaign} apiConfigured={true} />
          ) : view === "content" ? (
            <ContentStudioView
              marketingHub={marketingHub}
              team={team}
              onCreateCampaign={createMarketingCampaign}
              onGenerate={generateMarketingContent}
              onApprove={approveMarketingContent}
              onGenerateImage={generateBrandedImage}
            />
          ) : view === "actionsites" ? (
            <ActionSitesView clients={clients} onOpen={(id) => { setSelectedId(id); setView("clients"); setDetailTab("dashboard"); }} />
          ) : (
            <SettingsView zohoStatus={zohoStatus} zohoError={zohoError} onTest={checkZoho} team={team} onAddTeamMember={addTeamMember} onRemoveTeamMember={removeTeamMember}
              emailTemplates={emailTemplates} onAddTemplate={addEmailTemplate} onRemoveTemplate={removeEmailTemplate} onPatchTemplate={patchEmailTemplate} />
          )}
        </div>
      </div>

      {/* Detail drawer */}
      {selectedClient && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}>
          <div className="drawer">
            <div className="drawer-head">
              <div>
                <div className="display" style={{ fontSize: 20 }}>{clientDisplayName(selectedClient)}</div>
                <div style={{ fontSize: 12, color: "#B9C2CC", marginTop: 2 }}>{selectedClient.company || "No company set"}</div>
                {(selectedClient.tags || []).length > 0 || selectedClient.assessment?.completed || selectedClient.newsletter?.subscribed || selectedClient.proBono || paymentPills(selectedClient).hasPaid || paymentPills(selectedClient).hasDue ? <div style={{ marginTop: 8, display: "flex", gap: 4, flexWrap: "wrap" }}>{selectedClient.assessment?.completed && <Pill tone="green">Assessment Completed</Pill>}{isFpLead(selectedClient) && <Pill tone="purple">FP Lead</Pill>}{selectedClient.newsletter?.subscribed && <Pill tone="navy">Newsletter Subscriber</Pill>}{selectedClient.proBono && <Pill tone="slate">Pro-Bono</Pill>}{paymentPills(selectedClient).hasPaid && <Pill tone="green">Paid</Pill>}{paymentPills(selectedClient).hasDue && <Pill tone="gold">Payment Due</Pill>}{(selectedClient.tags || []).map(t => <Pill key={t} tone="coral">{t}</Pill>)}</div> : null}
                <div style={{ marginTop: 10 }}><AscentPath client={selectedClient} size="md" /></div>
              </div>
              <button className="btn-ghost btn btn-sm" style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "none" }} onClick={() => setSelectedId(null)}><X size={15} /></button>
            </div>
            <div className="tabs">
              {[
                { k: "profile", label: "Profile", icon: User },
                { k: "assessment", label: "Assessment", icon: ClipboardCheck },
                { k: "campaigns", label: "Campaigns", icon: Rocket },
                { k: "contract", label: "Contract", icon: FileSignature },
                { k: "dashboard", label: "Dashboard", icon: Github },
                { k: "billing", label: "Billing", icon: CreditCard },
                { k: "tasks", label: "Tasks", icon: ListChecks },
                { k: "activity", label: "Activity", icon: History },
              ].map(t => (
                <div key={t.k} className={"tab" + (detailTab === t.k ? " active" : "")} onClick={() => setDetailTab(t.k)}><t.icon size={13} /> {t.label}</div>
              ))}
            </div>
            <div className="drawer-body">
              {detailTab === "profile" && <ProfileTab client={selectedClient} onPatch={(p) => patchClient(selectedClient.id, p)} onDelete={() => deleteClient(selectedClient.id)} onComposeEmail={() => setEmailComposerClient(selectedClient)} />}
              {detailTab === "assessment" && <AssessmentTab client={selectedClient} onPatch={(p) => patchNested(selectedClient.id, "assessment", p)} />}
              {detailTab === "campaigns" && (
                <CampaignsTab client={selectedClient}
                  onPatchNewsletter={(p) => patchNested(selectedClient.id, "newsletter", p)}
                  onPatchZoho={(p) => patchNested(selectedClient.id, "zoho", p)}
                  onAddSocial={() => addSocial(selectedClient.id)} onPatchSocial={(sid, p) => patchSocial(selectedClient.id, sid, p)} onRemoveSocial={(sid) => removeSocial(selectedClient.id, sid)}
                  apiConfigured={true} />
              )}
              {detailTab === "contract" && <ContractTab client={selectedClient} onPatch={(p) => patchNested(selectedClient.id, "contract", p)} />}
              {detailTab === "dashboard" && <DashboardTab client={selectedClient} onPatch={(p) => patchNested(selectedClient.id, "dashboard", p)} />}
              {detailTab === "billing" && <BillingTab client={selectedClient} onAdd={(e) => addBilling(selectedClient.id, e)} onPatch={(bid, p) => patchBilling(selectedClient.id, bid, p)} onRemove={(bid) => removeBilling(selectedClient.id, bid)} onPatchClient={(p) => patchClient(selectedClient.id, p)} />}
              {detailTab === "tasks" && <ClientTasksTab client={selectedClient} team={team} onAdd={(t) => addTask(selectedClient.id, t)} onToggle={(tid) => toggleTask(selectedClient.id, tid)} onRemove={(tid) => removeTask(selectedClient.id, tid)} onPatch={(tid, patch) => patchTask(selectedClient.id, tid, patch)} />}
              {detailTab === "activity" && <ClientActivityTab client={selectedClient} activityLog={activityLog} />}
            </div>
          </div>
        </div>
      )}

      {showAddModal && (
        <div className="overlay center" onClick={(e) => { if (e.target === e.currentTarget) setShowAddModal(false); }}>
          <div className="modal"><AddClientForm onCancel={() => setShowAddModal(false)} onSave={(data) => { addClient(data); setShowAddModal(false); }} /></div>
        </div>
      )}

      {emailComposerClient && (
        <div className="overlay center" onClick={(e) => { if (e.target === e.currentTarget) setEmailComposerClient(null); }}>
          <div className="modal">
            <EmailComposer
              client={emailComposerClient}
              onCancel={() => setEmailComposerClient(null)}
              onSent={async () => { setEmailComposerClient(null); await loadCrmData(); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Overview / Dashboard ----------

// Classifies an activity-log entry's free-text string into a labeled,
// colored type. There's no structured "type" field on activity entries
// (they're built as plain text from many different call sites — the CRM
// itself, the assessment submit endpoint, and the Zoho/Beehiiv sync job),
// so this matches on the known phrasing each source actually produces.
// If a new activity message pattern gets added later and doesn't match
// anything here, it safely falls into "Other" rather than breaking.
function categorizeActivity(text) {
  const t = text || "";
  if (/completed the .* assessment/i.test(t)) return { key: "assessment", label: "Assessment completed", tone: "green" };
  if (/emailed us:/i.test(t)) return { key: "email", label: "Emails received", tone: "gold" };
  if (/^Emailed .*:/i.test(t)) return { key: "email_out", label: "Emails sent", tone: "navy" };
  if (/^(Added|Merged) .* (from|data into)/i.test(t) || /upgraded to|tagged CPA Lead|Corrected name for|Renamed \d+ existing/i.test(t)) return { key: "imported", label: "Imported / synced", tone: "navy" };
  if (/^Completed task/i.test(t)) return { key: "task", label: "Tasks", tone: "gold" };
  if (/^Added client|^Removed client/i.test(t)) return { key: "client", label: "Client changes", tone: "slate" };
  if (/^Logged \$/i.test(t)) return { key: "billing", label: "Billing", tone: "green" };
  if (/^Added marketing campaign/i.test(t)) return { key: "campaign", label: "Campaigns", tone: "gold" };
  if (/^Added team member|^Removed team member/i.test(t)) return { key: "team", label: "Team", tone: "slate" };
  return { key: "other", label: "Other", tone: "slate" };
}

// Simple expand/collapse section with a colored count pill in the header.
// Used anywhere we group a list into labeled buckets (activity feed, due
// soon, tasks-by-client) so the same look/interaction is consistent
// everywhere rather than rebuilding this per-section.
function CollapsibleGroup({ label, tone = "slate", count, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 10, border: "1px solid var(--slate-line, #E4E7EC)", borderRadius: 10, overflow: "hidden" }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", background: "var(--cloud-dim, #ECEEEA)", userSelect: "none" }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Pill tone={tone}>{label}</Pill>
        <span style={{ fontSize: 12, color: "var(--slate)" }}>{count}</span>
      </div>
      {open && <div style={{ padding: "4px 12px" }}>{children}</div>}
    </div>
  );
}

// Buckets a task's due date into an urgency tag used for color-coding
// within the Due Soon groups. Reuses the existing isOverdue() logic so
// "overdue" stays consistent with the rest of the app.
function urgencyOf(t) {
  if (isOverdue(t)) return { label: "overdue", tone: "coral" };
  if (!t.dueDate) return { label: "no due date", tone: "slate" };
  const due = new Date(t.dueDate);
  const today = new Date(todayISO());
  const diffDays = Math.round((due - today) / 86400000);
  if (diffDays <= 0) return { label: "today", tone: "gold" };
  if (diffDays <= 7) return { label: "this week", tone: "navy" };
  return { label: "later", tone: "slate" };
}

function PendingEmailCard({ draft, clients, onOpen, onApprove }) {
  const client = clients.find(c => c.id === draft.clientId);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handle(action) {
    setBusy(true); setError("");
    const result = await onApprove(draft.id, action, editing ? { subject, body } : undefined);
    setBusy(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <div className="card" style={{ padding: 14, marginBottom: 10, borderLeft: "3px solid var(--coral)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 12.5, color: "var(--slate)" }}>
            AI-drafted reply to <span className="client-name" style={{ cursor: client ? "pointer" : "default" }} onClick={() => client && onOpen(client.id)}>{client ? clientDisplayName(client) : "Unknown client"}</span>
            {draft.sourceSubject && <> — re: "{draft.sourceSubject}"</>}
          </div>
        </div>
        <span style={{ fontSize: 11, color: "var(--slate)" }}>{timeAgo(draft.createdAt)}</span>
      </div>

      {editing ? (
        <>
          <Field label="Subject"><input value={subject} onChange={e => setSubject(e.target.value)} /></Field>
          <Field label="Body"><textarea rows={6} value={body} onChange={e => setBody(e.target.value)} style={{ width: "100%", resize: "vertical" }} /></Field>
        </>
      ) : (
        <>
          <div className="task-title" style={{ marginBottom: 4 }}>{draft.subject}</div>
          <div style={{ fontSize: 12.5, color: "var(--slate)", whiteSpace: "pre-wrap" }}>{draft.body}</div>
        </>
      )}

      {error && <div style={{ fontSize: 12, color: "var(--coral)", marginTop: 8 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => handle("approve")}>
          {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Approve & send
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(e => !e)}>
          {editing ? "Cancel edit" : "Edit first"}
        </button>
        <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => handle("reject")}>
          <X size={13} /> Reject
        </button>
      </div>
    </div>
  );
}

function OverviewView({ clients, revenue, activityLog, team, pendingEmails, onApprovePendingEmail, assessedCount, activeCampaignCount, overdueCount, marketingCampaigns, zohoLive, zohoStatus, onOpen }) {
  const upcoming = useMemo(() => {
    const list = [];
    clients.forEach(c => (c.tasks || []).forEach(t => { if (t.status !== "done") list.push({ ...t, clientName: clientDisplayName(c) }); }));
    return list.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
  }, [clients]);

  function memberName(id) { return (team || []).find(m => m.id === id)?.name || ""; }

  const marketing = zohoStatus === "live" ? zohoLive : marketingCampaigns;
  const totalSpend = marketing.reduce((s, c) => s + (Number(c.spend) || 0), 0);
  const totalLeads = marketing.reduce((s, c) => s + (Number(c.leads) || 0), 0);
  const blendedCpa = totalLeads ? totalSpend / totalLeads : 0;

  return (
    <>
      {(pendingEmails || []).length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div className="section-title" style={{ color: "var(--coral)" }}>
            <AlertTriangle size={14} /> Pending email approvals ({pendingEmails.length})
          </div>
          <div>
            {pendingEmails.map(p => (
              <PendingEmailCard key={p.id} draft={p} clients={clients} onOpen={onOpen} onApprove={onApprovePendingEmail} />
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
        <a href="https://campaigns.zoho.com/campaigns/org930482684/home.do" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
          <Rocket size={13} /> Open Zoho Campaigns <ExternalLink size={11} />
        </a>
        <a href="https://app.beehiiv.com" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
          <Newspaper size={13} /> Open Beehiiv <ExternalLink size={11} />
        </a>
      </div>

      <div className="stat-grid">
        <StatCard label="Total clients" value={clients.length} icon={Users2} tone="navy" />
        <StatCard label="Revenue this month" value={fmtMoney(revenue.mtd)} icon={DollarSign} tone="green" sub={`${fmtMoney(revenue.total)} all-time`} />
        <StatCard label="Marketing spend" value={fmtMoney(totalSpend)} icon={Megaphone} tone="gold" sub={totalLeads ? `${fmtMoney(blendedCpa)} / lead` : "no leads logged"} />
        <StatCard label="Overdue tasks" value={overdueCount} icon={AlertTriangle} tone="coral" />
      </div>

      <div className="two-col">
        <div>
          <div className="section-title">Client journeys</div>
          <div className="card" style={{ padding: 8, marginBottom: 24 }}>
            {clients.length === 0 ? (
              <div className="empty-state"><div className="display">No clients yet</div>Add your first client to start tracking their journey.</div>
            ) : (
              <table className="ctable">
                <thead><tr><th>Client</th><th>Journey</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {clients.slice(0, 8).map(c => (
                    <tr key={c.id} className="row-click" onClick={() => onOpen(c.id)}>
                      <td><div className="client-name">{clientDisplayName(c)}</div><div className="client-sub">{c.company}</div></td>
                      <td><AscentPath client={c} /></td>
                      <td><StatusPill status={c.status} /></td>
                      <td style={{ textAlign: "right" }}><ChevronRight size={15} color="var(--slate)" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="section-title">Due soon</div>
          <div style={{ marginBottom: 24 }}>
            {upcoming.length === 0 ? (
              <div className="card empty-state" style={{ padding: 24 }}>Nothing on the horizon.</div>
            ) : (() => {
              const groups = new Map();
              upcoming.forEach(t => {
                const memberKey = t.assignedTo || "unassigned";
                const label = t.assignedTo ? (memberName(t.assignedTo) || "Unknown") : "Unassigned";
                if (!groups.has(memberKey)) groups.set(memberKey, { label, items: [] });
                groups.get(memberKey).items.push(t);
              });
              // Unassigned sorts last — assigned work is what you're grouping to prioritize.
              const sortedGroups = Array.from(groups.values()).sort((a, b) => a.label === "Unassigned" ? 1 : b.label === "Unassigned" ? -1 : a.label.localeCompare(b.label));
              return sortedGroups.map(g => (
                <CollapsibleGroup key={g.label} label={g.label} tone={g.items.some(isOverdue) ? "coral" : "navy"} count={g.items.length}>
                  {g.items.map(t => {
                    const u = urgencyOf(t);
                    return (
                      <div className="task-row" key={t.id}>
                        <span className="task-check"><Circle size={16} /></span>
                        <div style={{ flex: 1 }}>
                          <div className="task-title">{t.title}</div>
                          <div className="task-meta"><User size={11} /> {t.clientName} · owed by {t.owner === "client" ? "client" : "us"}{t.blockStart && <> · working {fmtDate(t.blockStart)}–{fmtDate(t.blockEnd)}</>}</div>
                        </div>
                        <Pill tone={u.tone}>{u.label}</Pill>
                        {t.dueDate && <Pill tone="slate">{fmtDate(t.dueDate)}</Pill>}
                      </div>
                    );
                  })}
                </CollapsibleGroup>
              ));
            })()}
          </div>
        </div>

        <div>
          <div className="section-title">Current activity</div>
          <div style={{ marginBottom: 24 }}>
            {activityLog.length === 0 ? (
              <div className="card empty-state" style={{ padding: 24 }}>Activity will show up here as you use the CRM.</div>
            ) : (() => {
              const groups = new Map();
              activityLog.forEach(a => {
                const cat = categorizeActivity(a.text);
                if (!groups.has(cat.key)) groups.set(cat.key, { ...cat, items: [] });
                groups.get(cat.key).items.push(a);
              });
              return Array.from(groups.values()).map(g => (
                <CollapsibleGroup key={g.key} label={g.label} tone={g.tone} count={g.items.length} defaultOpen={g.key !== "other"}>
                  {g.items.map(a => (
                    <div className="activity-row" key={a.id}><span className="activity-dot" /><span>{a.text}</span><span className="activity-time">{timeAgo(a.ts)}</span></div>
                  ))}
                </CollapsibleGroup>
              ));
            })()}
          </div>

          <div className="section-title">Prospecting snapshot {zohoStatus === "live" && <Pill tone="green">live from Zoho</Pill>}</div>
          <div className="card" style={{ padding: 16 }}>
            {zohoStatus !== "live" && (
              <div className="conn-banner conn-off" style={{ marginBottom: 12 }}>
                <WifiOff size={15} /> Showing manually-logged campaigns. Connect Zoho in Settings for live numbers.
              </div>
            )}
            {marketing.length === 0 ? <div className="empty-state" style={{ padding: 16 }}>No campaigns logged yet.</div> : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 8, color: "var(--slate)" }}>
                  <span>{marketing.length} active campaign{marketing.length !== 1 ? "s" : ""}</span>
                  <span>{totalLeads} leads</span>
                </div>
                {marketing.slice(0, 5).map(c => (
                  <div key={c.id} className="task-row">
                    <div style={{ flex: 1 }}>
                      <div className="task-title">{c.name}</div>
                      <div className="task-meta">{c.platform}</div>
                    </div>
                    <Pill tone="navy">{fmtMoney(c.spend)}</Pill>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function StatusPill({ status }) {
  const tone = status === "active" ? "green" : status === "opportunity" ? "gold" : status === "lead" ? "gold" : status === "prospect" ? "navy" : "slate";
  return <Pill tone={tone}>{status}</Pill>;
}

// ---------- Clients list ----------

function ClientsView({ clients, search, setSearch, statusFilter, setStatusFilter, showHidden, setShowHidden, hiddenCount, onOpen, onToggleHidden, total, apiBaseUrl }) {
  const [selected, setSelected] = useState({});
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [sortKey, setSortKey] = useState("client");
  const [sortDir, setSortDir] = useState("asc");

  const STATUS_ORDER = { lead: 1, prospect: 2, opportunity: 3, active: 4, inactive: 5 };
  function journeyProgress(c) { return STAGES.filter(s => stageComplete(c, s.key)).length; }
  function sortValue(c, key) {
    if (key === "client") return (c.lastName || (c.name || "").split(/\s+/).slice(-1)[0] || clientDisplayName(c)).toLowerCase();
    if (key === "contact") return (c.email || "").toLowerCase();
    if (key === "journey") return journeyProgress(c);
    if (key === "status") return STATUS_ORDER[c.status] || 99;
    if (key === "createdAt") return c.createdAt || "";
    return "";
  }
  function sortBy(key) {
    if (sortKey === key) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }
  const sortedClients = useMemo(() => {
    if (!sortKey) return clients;
    const copy = [...clients];
    copy.sort((a, b) => {
      const av = sortValue(a, sortKey), bv = sortValue(b, sortKey);
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }, [clients, sortKey, sortDir]);

  function SortTh({ label, colKey }) {
    const active = sortKey === colKey;
    return (
      <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => sortBy(colKey)}>
        {label} <span style={{ fontSize: 10, opacity: active ? 1 : 0.3 }}>{active ? (sortDir === "asc" ? "▲" : "▼") : "▲"}</span>
      </th>
    );
  }

  const selectedClients = sortedClients.filter(c => selected[c.id]);
  const selectedCount = selectedClients.length;

  function toggle(id, e) {
    e.stopPropagation();
    setSelected(prev => ({ ...prev, [id]: !prev[id] }));
  }
  function toggleAll() {
    if (selectedCount === sortedClients.length) setSelected({});
    else setSelected(Object.fromEntries(sortedClients.map(c => [c.id, true])));
  }

  async function sendDemoPitch() {
    if (!apiBaseUrl || selectedCount === 0) return;
    setSending(true);
    setSendResult(null);
    setConfirming(false);
    try {
      const base = apiBaseUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/leads/send-demo-pitch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leads: selectedClients.map(c => ({ name: c.name, email: c.email, company: c.company })) }),
      });
      const data = await res.json();
      const okCount = (data.results || []).filter(r => r.ok).length;
      setSendResult({ ok: true, message: `Sent to ${okCount} of ${selectedCount}.` });
      setSelected({});
    } catch (e) {
      setSendResult({ ok: false, message: "Couldn't reach the send-demo-pitch endpoint — check the API base URL in Settings." });
    }
    setSending(false);
  }

  return (
    <>
      <div className="toolbar" style={{ flexWrap: "wrap", rowGap: 8 }}>
        <div className="search-box"><Search size={14} color="var(--slate)" /><input placeholder="Search name, company, email…" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <select className="filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option><option value="prospect">Prospect</option><option value="opportunity">Opportunity</option><option value="lead">Lead</option><option value="active">Active</option><option value="inactive">Inactive</option>
        </select>
        <select className="filter-select" value={sortKey} onChange={e => { const k = e.target.value; setSortKey(k); setSortDir(k === "createdAt" ? "desc" : "asc"); }}>
          <option value="client">Sort: Last name</option>
          <option value="contact">Sort: Email</option>
          <option value="journey">Sort: Journey progress</option>
          <option value="status">Sort: Status (Lead → Prospect → Opportunity → Active → Inactive)</option>
          <option value="createdAt">Sort: Date added (newest first)</option>
        </select>
        <button className="btn btn-ghost btn-sm" onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")} title="Toggle sort direction">
          {sortDir === "asc" ? "▲ Ascending" : "▼ Descending"}
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--slate)", cursor: "pointer" }}>
          <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />
          Show hidden clients
        </label>
        <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--slate)" }}>{clients.length} of {total}</div>
      </div>
      {!showHidden && !search.trim() && hiddenCount > 0 && (
        <div className="conn-banner conn-off">
          {hiddenCount} client{hiddenCount === 1 ? " is" : "s are"} hidden — search for a name/email to find one, or check "Show hidden clients" above.
        </div>
      )}

      {selectedCount > 0 && (
        <div className="conn-banner conn-off" style={{ justifyContent: "space-between" }}>
          <span>{selectedCount} selected</span>
          {confirming ? (
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12 }}>Send to {selectedCount} confirmed prospect{selectedCount > 1 ? "s" : ""}?</span>
              <button className="btn btn-gold btn-sm" disabled={sending} onClick={sendDemoPitch}>{sending ? <Loader2 size={13} className="spin" /> : "Yes, send"}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>Cancel</button>
            </span>
          ) : (
            <button className="btn btn-gold btn-sm" disabled={!apiBaseUrl} onClick={() => setConfirming(true)}><Send size={13} /> Send demo pitch</button>
          )}
        </div>
      )}
      {sendResult && <div className={"conn-banner " + (sendResult.ok ? "conn-live" : "conn-error")}>{sendResult.message}</div>}
      {!apiBaseUrl && selectedCount > 0 && <div className="conn-banner conn-off">Set the API base URL in Settings first — that's what the demo-pitch send calls.</div>}

      <div className="card" style={{ padding: 8 }}>
        {sortedClients.length === 0 ? <div className="empty-state"><div className="display">No matches</div>Try a different search or filter.</div> : (
          <table className="ctable">
            <thead><tr>
              <th style={{ width: 32 }}><input type="checkbox" checked={selectedCount === sortedClients.length && sortedClients.length > 0} onChange={toggleAll} /></th>
              <SortTh label="Client" colKey="client" /><SortTh label="Contact" colKey="contact" /><SortTh label="Journey" colKey="journey" /><SortTh label="Status" colKey="status" /><SortTh label="Added" colKey="createdAt" /><th></th><th></th>
            </tr></thead>
            <tbody>
              {sortedClients.map(c => (
                <tr key={c.id} className="row-click" onClick={() => onOpen(c.id)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={!!selected[c.id]} onChange={(e) => toggle(c.id, e)} /></td>
                  <td><div className="client-name">{clientDisplayName(c)}</div><div className="client-sub">{c.name ? c.company : ""}</div>{((c.tags || []).length > 0 || c.assessment?.completed || c.newsletter?.subscribed || c.proBono || paymentPills(c).hasPaid || paymentPills(c).hasDue) && <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>{c.assessment?.completed && <Pill tone="green">Assessment Completed</Pill>}{isFpLead(c) && <Pill tone="purple">FP Lead</Pill>}{c.newsletter?.subscribed && <Pill tone="navy">Newsletter Subscriber</Pill>}{c.proBono && <Pill tone="slate">Pro-Bono</Pill>}{paymentPills(c).hasPaid && <Pill tone="green">Paid</Pill>}{paymentPills(c).hasDue && <Pill tone="gold">Payment Due</Pill>}{(c.tags || []).map(t => <Pill key={t} tone="coral">{t}</Pill>)}</div>}</td>
                  <td><div style={{ fontSize: 12.5 }}>{c.email}</div><div className="client-sub">{c.phone}</div></td>
                  <td><AscentPath client={c} /></td>
                  <td><StatusPill status={c.status} /></td>
                  <td style={{ fontSize: 12, color: "var(--slate)" }}>{c.createdAt ? timeAgo(c.createdAt) : "—"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-ghost btn-sm" title={c.hidden ? "Unhide" : "Hide from main list"} onClick={() => onToggleHidden(c.id, !c.hidden)}>
                      {c.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
                    </button>
                  </td>
                  <td style={{ textAlign: "right" }}><ChevronRight size={15} color="var(--slate)" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ---------- Tasks ----------

function TasksView({ tasks, ownerFilter, setOwnerFilter, team, assigneeFilter, setAssigneeFilter, onToggle, onOpenClient }) {
  const filtered = tasks.filter(t => (ownerFilter === "all" || t.owner === ownerFilter) && (assigneeFilter === "all" || (assigneeFilter === "unassigned" ? !t.assignedTo : t.assignedTo === assigneeFilter))).sort((a, b) => {
    const ao = isOverdue(a) ? 0 : 1, bo = isOverdue(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    if (a.status !== b.status) return a.status === "done" ? 1 : -1;
    return (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
  });
  function memberName(id) { return (team || []).find(m => m.id === id)?.name || ""; }

  const groups = useMemo(() => {
    const map = new Map();
    filtered.forEach(t => {
      if (!map.has(t.clientId)) map.set(t.clientId, { clientName: t.clientName, items: [] });
      map.get(t.clientId).items.push(t);
    });
    // Clients with any overdue task float to the top — that's what needs attention first.
    return Array.from(map.values()).sort((a, b) => {
      const ao = a.items.some(isOverdue) ? 0 : 1, bo = b.items.some(isOverdue) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return (a.clientName || "").localeCompare(b.clientName || "");
    });
  }, [filtered]);

  return (
    <>
      <div className="toolbar">
        <select className="filter-select" value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)}>
          <option value="all">All tasks</option><option value="client">Owed by client</option><option value="team">Owed by us</option>
        </select>
        <select className="filter-select" value={assigneeFilter} onChange={e => setAssigneeFilter(e.target.value)}>
          <option value="all">Anyone assigned</option>
          <option value="unassigned">Unassigned</option>
          {(team || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <div style={{ fontSize: 12, color: "var(--slate)" }}>{filtered.filter(t => t.status !== "done").length} open</div>
      </div>
      {groups.length === 0 ? (
        <div className="card empty-state"><div className="display">No tasks yet</div>Add tasks from a client's Tasks tab to track campaigns that keep everyone on track.</div>
      ) : groups.map(g => (
        <CollapsibleGroup key={g.clientName} label={g.clientName || "Unknown client"} tone={g.items.some(isOverdue) ? "coral" : "navy"} count={g.items.length}>
          {g.items.map(t => (
            <div className="task-row" key={t.id + t.clientId}>
              <span className="task-check" onClick={() => onToggle(t.clientId, t.id)}>{t.status === "done" ? <CheckCircle2 size={16} /> : <Circle size={16} />}</span>
              <div style={{ flex: 1, cursor: "pointer" }} onClick={() => onOpenClient(t.clientId)}>
                <div className={"task-title" + (t.status === "done" ? " done" : "")}>{t.title}</div>
                <div className="task-meta">
                  <Pill tone={t.owner === "client" ? "gold" : "navy"}>{t.owner === "client" ? "client owes" : "we owe"}</Pill>
                  {t.assignedTo && memberName(t.assignedTo) && <Pill tone="slate">{memberName(t.assignedTo)}</Pill>}
                  {t.blockStart && <span>· <Clock size={11} /> work {fmtDate(t.blockStart)}–{fmtDate(t.blockEnd)}</span>}
                </div>
              </div>
              {t.dueDate && <Pill tone={isOverdue(t) ? "coral" : "slate"}>{fmtDate(t.dueDate)}</Pill>}
            </div>
          ))}
        </CollapsibleGroup>
      ))}
    </>
  );
}

// ---------- Marketing ----------

function MarketingView({ campaigns, zohoLive, zohoStatus, onRefresh, onAdd, onPatch, onRemove, apiConfigured }) {
  const [showForm, setShowForm] = useState(false);
  const usingLive = zohoStatus === "live";
  const list = usingLive ? zohoLive : campaigns;

  return (
    <>
      {!apiConfigured && (
        <div className="conn-banner conn-off"><WifiOff size={15} /> No Zoho API route configured yet. Add the base URL in Settings once it's deployed — until then, log campaigns manually below.</div>
      )}
      {apiConfigured && zohoStatus === "checking" && (
        <div className="conn-banner conn-off"><Loader2 size={15} className="spin" /> Checking Zoho connection…</div>
      )}
      {apiConfigured && zohoStatus === "error" && (
        <div className="conn-banner conn-error"><WifiOff size={15} /> Couldn't reach the Zoho route at that URL. Showing manually-logged campaigns instead. <button className="btn btn-ghost btn-sm" onClick={onRefresh}><RefreshCw size={12} /> Retry</button></div>
      )}
      {apiConfigured && zohoStatus === "live" && (
        <div className="conn-banner conn-live"><Wifi size={15} /> Connected — showing live campaign data from Zoho. <button className="btn btn-ghost btn-sm" onClick={onRefresh}><RefreshCw size={12} /> Refresh</button></div>
      )}

      <div className="toolbar">
        <div style={{ fontSize: 12, color: "var(--slate)" }}>{list.length} campaign{list.length !== 1 ? "s" : ""}</div>
        {!usingLive && <button className="btn btn-gold btn-sm" style={{ marginLeft: "auto" }} onClick={() => setShowForm(s => !s)}><Plus size={13} /> Log campaign</button>}
      </div>

      {showForm && !usingLive && (
        <div className="card" style={{ padding: 14, marginBottom: 16 }}>
          <CampaignForm onSave={(data) => { onAdd(data); setShowForm(false); }} onCancel={() => setShowForm(false)} />
        </div>
      )}

      <div className="card" style={{ padding: 8 }}>
        {list.length === 0 ? (
          <div className="empty-state"><div className="display">No campaigns yet</div>{usingLive ? "Nothing returned from Zoho yet." : "Log a CPA campaign to start tracking spend and leads."}</div>
        ) : (
          <table className="ctable">
            <thead><tr><th>Campaign</th><th>Platform</th><th>Spend</th><th>Leads</th><th>Cost / lead</th><th>Status</th>{!usingLive && <th></th>}</tr></thead>
            <tbody>
              {list.map(c => {
                const cpa = Number(c.leads) ? (Number(c.spend) || 0) / Number(c.leads) : 0;
                return (
                  <tr key={c.id}>
                    <td><div className="client-name" style={{ fontSize: 13.5 }}>{c.name}</div>{c.link && <a href={c.link} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--navy)" }}>Open campaign ↗</a>}</td>
                    <td>{c.platform}</td>
                    <td>{fmtMoney(c.spend)}</td>
                    <td>{c.leads || 0}</td>
                    <td>{fmtMoney(cpa)}</td>
                    <td><Pill tone={c.status === "active" ? "green" : c.status === "paused" ? "gold" : "slate"}>{c.status}</Pill></td>
                    {!usingLive && <td style={{ textAlign: "right" }}><button className="btn-danger btn btn-sm" onClick={() => onRemove(c.id)}><Trash2 size={12} /></button></td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function CampaignForm({ onSave, onCancel, initial }) {
  const [name, setName] = useState(initial?.name || "");
  const [platform, setPlatform] = useState(initial?.platform || "Zoho CPA");
  const [spend, setSpend] = useState(initial?.spend || "");
  const [leads, setLeads] = useState(initial?.leads || "");
  const [status, setStatus] = useState(initial?.status || "active");
  const [link, setLink] = useState(initial?.link || "");
  function submit(e) { e.preventDefault(); if (!name.trim()) return; onSave({ name: name.trim(), platform, spend, leads, status, link }); }
  return (
    <form onSubmit={submit}>
      <div className="field-row">
        <Field label="Campaign name"><input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Advisor CPA – Facebook" /></Field>
        <Field label="Platform">
          <select value={platform} onChange={e => setPlatform(e.target.value)}>
            <option>Zoho CPA</option><option>Google Ads</option><option>Facebook</option><option>LinkedIn</option><option>Other</option>
          </select>
        </Field>
      </div>
      <div className="field-row">
        <Field label="Spend ($)"><input type="number" value={spend} onChange={e => setSpend(e.target.value)} /></Field>
        <Field label="Leads"><input type="number" value={leads} onChange={e => setLeads(e.target.value)} /></Field>
        <Field label="Status">
          <select value={status} onChange={e => setStatus(e.target.value)}><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option></select>
        </Field>
      </div>
      <Field label="Campaign link"><input value={link} onChange={e => setLink(e.target.value)} placeholder="https://campaigns.zoho.com/…" /></Field>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="btn btn-gold btn-sm"><Save size={13} /> Save</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ---------- Content Studio ----------

// Friendly tier names the frontend is allowed to know about — never the
// actual Zoho list keys behind them (those are env-var secrets, resolved
// server-side in api/marketing/approve.js via lib/zoho.js's TIER_LIST_KEYS).
const CONTENT_TARGET_TIERS = [
  { group: "General Business", tiers: ["Exploring", "Building", "Emerging", "AI-Ready"] },
  { group: "Financial Services", tiers: ["Early Stage", "Developing", "Intermediate", "Advanced"] },
];

const CONTENT_TYPE_LABELS = {
  email: "Email",
  linkedin_post: "LinkedIn post",
  facebook_post: "Facebook post",
};

function NewCampaignForm({ team, onCreate, onDone }) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [notes, setNotes] = useState("");
  const [owner, setOwner] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError("");
    const result = await onCreate({ name: name.trim(), goal, audience, notes, owner, startDate, endDate });
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    onDone();
  }

  return (
    <form onSubmit={submit} className="card" style={{ padding: 16, marginBottom: 16 }}>
      <Field label="Campaign name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Q3 Referral Push" /></Field>
      <div className="field-row">
        <Field label="Owner (optional)">
          <select value={owner} onChange={e => setOwner(e.target.value)}>
            <option value="">Unassigned</option>
            {(team || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Goal (optional)"><input value={goal} onChange={e => setGoal(e.target.value)} placeholder="e.g. Re-engage stalled FP leads" /></Field>
      </div>
      <div className="field-row">
        <Field label="Start date (optional)"><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></Field>
        <Field label="End date (optional)"><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></Field>
      </div>
      <Field label="Audience (optional)"><input value={audience} onChange={e => setAudience(e.target.value)} placeholder="e.g. FP leads, Building/Emerging tier" /></Field>
      <Field label="Notes (optional)"><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={{ width: "100%", resize: "vertical" }} /></Field>
      {error && <div style={{ fontSize: 12, color: "var(--coral)", marginBottom: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="btn btn-gold btn-sm" disabled={busy || !name.trim()}>
          {busy ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Create campaign
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function GenerateContentForm({ campaigns, lockedCampaignId, onGenerate }) {
  const [campaignId, setCampaignId] = useState("");
  const [type, setType] = useState("email");
  const [brief, setBrief] = useState("");
  const [targetTier, setTargetTier] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastResult, setLastResult] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(""); setLastResult(null);
    const result = await onGenerate({ campaignId: lockedCampaignId || campaignId || null, type, brief, targetTier: type === "email" ? targetTier : undefined });
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    setLastResult(result.item);
    setBrief("");
  }

  return (
    <form onSubmit={submit} className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div className="task-title" style={{ marginBottom: 10 }}>Generate new content</div>
      <div style={{ display: "flex", gap: 12 }}>
        {!lockedCampaignId && (
          <div style={{ flex: 1 }}>
            <Field label="Campaign (optional)">
              <select value={campaignId} onChange={e => setCampaignId(e.target.value)}>
                <option value="">No campaign — standalone</option>
                {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          </div>
        )}
        <div style={{ flex: 1 }}>
          <Field label="Type">
            <select value={type} onChange={e => setType(e.target.value)}>
              <option value="email">Email</option>
              <option value="linkedin_post">LinkedIn post</option>
              <option value="facebook_post">Facebook post</option>
            </select>
          </Field>
        </div>
      </div>
      {type === "email" && (
        <Field label="Target audience" hint="Which tier's list this email will send to — resolved to the real Zoho list server-side.">
          <select value={targetTier} onChange={e => setTargetTier(e.target.value)}>
            <option value="">Choose a tier…</option>
            {CONTENT_TARGET_TIERS.map(g => (
              <optgroup key={g.group} label={g.group}>
                {g.tiers.map(t => <option key={t} value={t}>{t}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
      )}
      <Field label="Brief / topic">
        <textarea rows={3} value={brief} onChange={e => setBrief(e.target.value)} style={{ width: "100%", resize: "vertical" }}
          placeholder="What should this piece be about? e.g. 'Re-engage leads who completed the assessment 60+ days ago but haven't booked a call.'" />
      </Field>
      {error && <div style={{ fontSize: 12, color: "var(--coral)", marginBottom: 8 }}>{error}</div>}
      {lastResult && <div style={{ fontSize: 12, color: "var(--green)", marginBottom: 8 }}>Drafted — check the approval queue below.</div>}
      <button type="submit" className="btn btn-gold btn-sm" disabled={busy}>
        {busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Generate draft
      </button>
    </form>
  );
}

function MarketingContentCard({ item, campaigns, onApprove, onGenerateImage }) {
  const campaign = campaigns.find(c => c.id === item.campaignId);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.body);
  const [targetTier, setTargetTier] = useState(item.targetTier || "");
  const [scheduledFor, setScheduledFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState("");

  async function handle(action) {
    setBusy(true); setError(""); setResult(null);
    const res = await onApprove(
      item.id, action,
      editing ? { subject, body } : undefined,
      { targetTier: item.type === "email" ? targetTier : undefined, scheduledFor: scheduledFor || undefined }
    );
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setResult(res);
  }

  async function handleGenerateImage() {
    setImageBusy(true); setImageError("");
    const res = await onGenerateImage(item.id);
    setImageBusy(false);
    if (!res.ok) setImageError(res.error);
  }

  const typeIcon = item.type === "linkedin_post" ? <Linkedin size={13} /> : item.type === "facebook_post" ? <Facebook size={13} /> : <Mail size={13} />;

  return (
    <div className="card" style={{ padding: 14, marginBottom: 10, borderLeft: "3px solid var(--gold)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Pill tone="gold">{typeIcon} {CONTENT_TYPE_LABELS[item.type] || item.type}</Pill>
          {campaign && <span style={{ fontSize: 12, color: "var(--slate)" }}>{campaign.name}</span>}
        </div>
        <span style={{ fontSize: 11, color: "var(--slate)" }}>{timeAgo(item.createdAt)}</span>
      </div>

      {editing ? (
        <>
          {item.type === "email" && <Field label="Subject"><input value={subject} onChange={e => setSubject(e.target.value)} /></Field>}
          <Field label="Body"><textarea rows={7} value={body} onChange={e => setBody(e.target.value)} style={{ width: "100%", resize: "vertical" }} /></Field>
        </>
      ) : item.type !== "email" && !item.hasImage ? (
        // Social posts without a generated image yet still get a branded
        // colored backdrop (same gradient as the tile cover) rather than
        // plain gray text on white — so reviewing a post in-app already
        // feels like previewing something real, not just reading a draft.
        <div style={{ position: "relative", borderRadius: 10, padding: 16, background: contentCoverGradient(item.type), overflow: "hidden", marginBottom: 4 }}>
          <CoverWatermark />
          <div style={{ position: "relative", zIndex: 1, fontSize: 13, color: "#fff", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{item.body}</div>
        </div>
      ) : (
        <>
          {item.type === "email" && <div className="task-title" style={{ marginBottom: 4 }}>{item.subject}</div>}
          <div style={{ fontSize: 12.5, color: "var(--slate)", whiteSpace: "pre-wrap" }}>{item.body}</div>
        </>
      )}

      {item.hasImage && (
        <div style={{ marginBottom: 10 }}>
          <img src={`/api/marketing/card-image?itemId=${item.id}&v=${encodeURIComponent(item.imageGeneratedAt || "")}`} alt={item.imageHeadline || "Branded card"} style={{ width: "100%", maxWidth: 320, borderRadius: 10, display: "block" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            {item.imageHeadline && <div style={{ fontSize: 11, color: "var(--slate)", fontStyle: "italic", flex: 1 }}>Headline: "{item.imageHeadline}"</div>}
            {item.imageUsedPhoto && <Pill tone="green">Real photo</Pill>}
          </div>
          <a
            href={`/api/marketing/card-image?itemId=${item.id}&v=${encodeURIComponent(item.imageGeneratedAt || "")}`}
            download={`${(item.imageHeadline || "branded-card").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`}
            className="btn btn-ghost btn-sm"
            style={{ marginTop: 8 }}
          >
            <Download size={12} /> Download image
          </a>
        </div>
      )}

      {item.type !== "email" && onGenerateImage && (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={imageBusy} onClick={handleGenerateImage}>
            {imageBusy ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />} {item.hasImage ? "Regenerate branded image" : "Generate branded image"}
          </button>
          {imageError && <div style={{ fontSize: 12, color: "var(--coral)", marginTop: 6 }}>{imageError}</div>}
        </div>
      )}

      {item.type === "email" && (
        <div style={{ marginTop: 10 }}>
          <Field label="Target tier (required to send)">
            <select value={targetTier} onChange={e => setTargetTier(e.target.value)}>
              <option value="">Choose a tier…</option>
              {CONTENT_TARGET_TIERS.map(g => (
                <optgroup key={g.group} label={g.group}>
                  {g.tiers.map(t => <option key={t} value={t}>{t}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Schedule for (optional — leave blank to send immediately on approval)">
            <input type="datetime-local" value={scheduledFor} onChange={e => setScheduledFor(e.target.value)} />
          </Field>
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: "var(--coral)", marginTop: 8 }}>{error}</div>}

      {result && result.postLink && (
        <div style={{ fontSize: 12, color: "var(--ink)", background: "var(--cloud-dim)", padding: 10, borderRadius: 8, marginTop: 8 }}>
          <div style={{ marginBottom: 6 }}>{result.note}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(result.body || body)}>
              <Copy size={12} /> Copy text
            </button>
            <a className="btn btn-ghost btn-sm" href={result.postLink} target="_blank" rel="noopener noreferrer"><Link2 size={12} /> Open composer</a>
          </div>
        </div>
      )}
      {result && result.action === "sent" && <div style={{ fontSize: 12, color: "var(--green)", marginTop: 8 }}>Sent via Zoho — campaign key {result.campaignKey}</div>}
      {result && result.action === "scheduled" && <div style={{ fontSize: 12, color: "var(--green)", marginTop: 8 }}>Scheduled via Zoho — campaign key {result.campaignKey}</div>}
      {result && result.note && !result.postLink && <div style={{ fontSize: 12, color: "var(--gold)", marginTop: 8 }}>{result.note}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => handle("approve")}>
          {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Approve{item.type === "email" ? (scheduledFor ? " & schedule" : " & send") : ""}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(e => !e)}>
          {editing ? "Cancel edit" : "Edit first"}
        </button>
        <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => handle("reject")}>
          <X size={13} /> Reject
        </button>
      </div>
    </div>
  );
}

function contentTypeIcon(type) {
  if (type === "linkedin_post") return <Linkedin size={16} />;
  if (type === "facebook_post") return <Facebook size={16} />;
  return <Mail size={16} />;
}

// A grid of small "asset" tiles for one campaign — the visual, HubSpot
// Marketing-Studio-like board view. Clicking a tile expands the full
// MarketingContentCard (approve/edit/reject, or just details if already
// sent) right below the grid, rather than a true draggable canvas — gets
// the same "see everything in this campaign at a glance" feel without the
// much larger engineering cost of freeform positioning/connecting lines.
// Branded cover gradient per content type — navy stays constant as the
// anchor (reinforcing brand consistency across every tile), the second
// color varies by type so tiles are visually distinguishable at a glance.
// All colors are the confirmed real brand-kit values, nothing invented.
function contentCoverGradient(type) {
  if (type === "linkedin_post") return "linear-gradient(135deg, var(--navy), var(--teal-accent))";
  if (type === "facebook_post") return "linear-gradient(135deg, var(--navy), var(--peach-accent))";
  return "linear-gradient(135deg, var(--navy), var(--navy-soft))"; // email
}

// The real 3-bar icon motif, reused here as a large, faded decorative
// watermark on each tile's cover — ties every card back to the actual
// brand mark rather than using generic platform-icon-only covers.
function CoverWatermark() {
  return (
    <svg width="72" height="72" viewBox="0 0 24 24" fill="none" style={{ position: "absolute", right: -10, bottom: -14, opacity: 0.16 }}>
      <rect x="5" y="6.5" width="14" height="2.6" rx="1.3" fill="#fff" />
      <rect x="5" y="10.7" width="14" height="2.6" rx="1.3" fill="#fff" />
      <rect x="5" y="14.9" width="14" height="2.6" rx="1.3" fill="#fff" />
    </svg>
  );
}

function CampaignBoard({ campaign, items, onApprove, onGenerateImage }) {
  const [expandedId, setExpandedId] = useState(null);
  const expandedItem = items.find(i => i.id === expandedId);

  const statusTone = { pending_approval: "gold", approved: "navy", scheduled: "navy", sent: "green", rejected: "coral" };

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14, marginBottom: 16 }}>
        {items.length === 0 ? (
          <div className="empty-state" style={{ padding: 20, gridColumn: "1 / -1" }}>No content in this campaign yet — use the form below to generate the first piece.</div>
        ) : items.map(item => (
          <div
            key={item.id}
            className="card"
            style={{ overflow: "hidden", cursor: "pointer", border: expandedId === item.id ? "2px solid var(--gold)" : undefined }}
            onClick={() => setExpandedId(id => id === item.id ? null : item.id)}
          >
            {item.hasImage ? (
              <div style={{ position: "relative", height: 140, overflow: "hidden" }}>
                <img src={`/api/marketing/card-image?itemId=${item.id}&v=${encodeURIComponent(item.imageGeneratedAt || "")}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                <div style={{ position: "absolute", top: 8, right: 8 }}><Pill tone={statusTone[item.status] || "slate"}>{item.status.replace("_", " ")}</Pill></div>
              </div>
            ) : (
              <div style={{ position: "relative", height: 64, background: contentCoverGradient(item.type), padding: "10px 12px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                <CoverWatermark />
                <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#fff", position: "relative", zIndex: 1 }}>
                  {contentTypeIcon(item.type)}
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>{CONTENT_TYPE_LABELS[item.type] || item.type}</span>
                </div>
                <div style={{ position: "relative", zIndex: 1 }}><Pill tone={statusTone[item.status] || "slate"}>{item.status.replace("_", " ")}</Pill></div>
              </div>
            )}
            <div style={{ padding: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                {item.subject || item.body.slice(0, 60)}
              </div>
              {item.targetTier && <div style={{ fontSize: 11, color: "var(--slate)" }}>{item.targetTier}</div>}
            </div>
          </div>
        ))}
      </div>
      {expandedItem && (
        <div style={{ marginBottom: 20 }}>
          <MarketingContentCard item={expandedItem} campaigns={[campaign]} onApprove={onApprove} onGenerateImage={onGenerateImage} />
        </div>
      )}
    </div>
  );
}

function ContentStudioView({ marketingHub, team, onCreateCampaign, onGenerate, onApprove, onGenerateImage }) {
  const [showNewCampaign, setShowNewCampaign] = useState(false);
  const [viewingCampaignId, setViewingCampaignId] = useState(null);
  const campaigns = marketingHub.campaigns || [];
  const items = marketingHub.contentItems || [];

  function memberName(id) { return (team || []).find(m => m.id === id)?.name || ""; }

  const viewingCampaign = campaigns.find(c => c.id === viewingCampaignId);

  if (viewingCampaign) {
    const campaignItems = items.filter(i => i.campaignId === viewingCampaign.id && i.status !== "rejected");
    return (
      <div>
        <button className="btn btn-ghost btn-sm" style={{ marginBottom: 14 }} onClick={() => setViewingCampaignId(null)}>
          <ChevronRight size={13} style={{ transform: "rotate(180deg)" }} /> Back to campaigns
        </button>
        <div className="card" style={{ padding: 16, marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div className="display" style={{ fontSize: 18 }}>{viewingCampaign.name}</div>
              {viewingCampaign.goal && <div style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 2 }}>{viewingCampaign.goal}</div>}
            </div>
            <Pill tone={viewingCampaign.status === "active" ? "green" : "slate"}>{viewingCampaign.status}</Pill>
          </div>
          <div style={{ display: "flex", gap: 18, marginTop: 12, fontSize: 12, color: "var(--slate)", flexWrap: "wrap" }}>
            {viewingCampaign.owner && <span><User size={11} /> {memberName(viewingCampaign.owner) || "Unknown"}</span>}
            {viewingCampaign.audience && <span>Audience: {viewingCampaign.audience}</span>}
            {(viewingCampaign.startDate || viewingCampaign.endDate) && <span><Calendar size={11} /> {viewingCampaign.startDate ? fmtDate(viewingCampaign.startDate) : "—"} → {viewingCampaign.endDate ? fmtDate(viewingCampaign.endDate) : "—"}</span>}
          </div>
          {viewingCampaign.notes && <div style={{ fontSize: 12.5, marginTop: 10, color: "var(--ink)" }}>{viewingCampaign.notes}</div>}
        </div>

        <div className="section-title">Assets ({campaignItems.length})</div>
        <CampaignBoard campaign={viewingCampaign} items={campaignItems} onApprove={onApprove} onGenerateImage={onGenerateImage} />

        <div className="section-title">Add content to this campaign</div>
        <GenerateContentForm campaigns={campaigns} lockedCampaignId={viewingCampaign.id} onGenerate={onGenerate} />
      </div>
    );
  }

  const pending = items.filter(i => i.status === "pending_approval" && !i.campaignId);
  const others = items.filter(i => i.status !== "pending_approval" && i.status !== "rejected" && !i.campaignId);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>Campaigns</div>
        {!showNewCampaign && (
          <button className="btn btn-gold btn-sm" onClick={() => setShowNewCampaign(true)}><Plus size={13} /> New campaign</button>
        )}
      </div>

      {showNewCampaign && <NewCampaignForm team={team} onCreate={onCreateCampaign} onDone={() => setShowNewCampaign(false)} />}

      {campaigns.length === 0 ? (
        <div className="empty-state" style={{ padding: 20, marginBottom: 20 }}>No campaigns yet — create one, or generate standalone content below.</div>
      ) : (
        <div className="card" style={{ padding: 8, marginBottom: 20, overflowX: "auto" }}>
          <table className="ctable">
            <thead><tr><th>Campaign</th><th>Owner</th><th>Notes</th><th>Start</th><th>End</th><th>Assets</th><th>Status</th></tr></thead>
            <tbody>
              {campaigns.map(c => {
                const count = items.filter(i => i.campaignId === c.id && i.status !== "rejected").length;
                return (
                  <tr key={c.id} className="row-click" onClick={() => setViewingCampaignId(c.id)}>
                    <td><div className="client-name" style={{ fontSize: 13.5 }}>{c.name}</div>{c.goal && <div className="client-sub">{c.goal}</div>}</td>
                    <td style={{ fontSize: 12.5 }}>{memberName(c.owner) || "—"}</td>
                    <td style={{ fontSize: 12, color: "var(--slate)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.notes || "—"}</td>
                    <td style={{ fontSize: 12 }}>{c.startDate ? fmtDate(c.startDate) : "—"}</td>
                    <td style={{ fontSize: 12 }}>{c.endDate ? fmtDate(c.endDate) : "—"}</td>
                    <td style={{ fontSize: 12 }}>{count}</td>
                    <td><Pill tone={c.status === "active" ? "green" : "slate"}>{c.status}</Pill></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-title">Generate standalone content</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginTop: -6, marginBottom: 12 }}>Not part of a campaign — for one-off pieces. To add content to a specific campaign, click into it above.</div>
      <GenerateContentForm campaigns={campaigns} onGenerate={onGenerate} />

      <div className="section-title">Pending approval — standalone ({pending.length})</div>
      {pending.length === 0 ? (
        <div className="empty-state" style={{ padding: 20, marginBottom: 20 }}>Nothing waiting on you right now.</div>
      ) : (
        <div style={{ marginBottom: 20 }}>
          {pending.map(item => <MarketingContentCard key={item.id} item={item} campaigns={campaigns} onApprove={onApprove} onGenerateImage={onGenerateImage} />)}
        </div>
      )}

      {others.length > 0 && (
        <>
          <div className="section-title">Approved, scheduled &amp; sent — standalone</div>
          <div className="card" style={{ padding: 4 }}>
            {others.map(item => (
              <div key={item.id} className="activity-row" style={{ padding: "10px 12px" }}>
                <div>
                  <div style={{ fontSize: 13 }}>{item.subject || item.body.slice(0, 60) + (item.body.length > 60 ? "…" : "")}</div>
                  <div style={{ fontSize: 11, color: "var(--slate)" }}>{CONTENT_TYPE_LABELS[item.type] || item.type}{item.targetTier ? ` — ${item.targetTier}` : ""}</div>
                </div>
                <Pill tone={item.status === "sent" ? "green" : item.status === "scheduled" ? "navy" : "slate"}>{item.status}</Pill>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Action Sites ----------

// Aggregates every client that has a built action-plan/dashboard site
// linked (client.dashboard.vercelUrl) into one quick-access list — pulls
// from the same field already editable in each client's Dashboard tab,
// so there's nothing new to maintain in two places. A client only shows
// up here once that field is actually set.
function ActionSitesView({ clients, onOpen }) {
  const sites = clients
    .filter(c => c.dashboard?.vercelUrl)
    .sort((a, b) => (a.dashboard.lastInterview || "").localeCompare(b.dashboard.lastInterview || "") * -1 || clientDisplayName(a).localeCompare(clientDisplayName(b)));

  if (sites.length === 0) {
    return (
      <div className="empty-state">
        <div className="display">No action sites linked yet</div>
        Open a client's Dashboard tab and add their Vercel URL — they'll show up here automatically.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
      {sites.map(c => (
        <div key={c.id} className="card" style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
            <div style={{ cursor: "pointer" }} onClick={() => onOpen(c.id)}>
              <div className="client-name">{clientDisplayName(c)}</div>
              {c.company && <div className="client-sub">{c.company}</div>}
            </div>
            <Globe size={16} color="var(--navy)" />
          </div>
          {c.dashboard.lastInterview && <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>Last interview: {fmtDate(c.dashboard.lastInterview)}</div>}
          {c.dashboard.notes && <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{c.dashboard.notes}</div>}
          <a href={c.dashboard.vercelUrl} target="_blank" rel="noreferrer" className="btn btn-gold btn-sm" style={{ width: "100%", justifyContent: "center" }}>
            <ExternalLink size={13} /> Open site
          </a>
        </div>
      ))}
    </div>
  );
}

// ---------- Import ----------

function ImportView({ sourceData, onRefresh, apiConfigured, findClientByEmail, onAdd, onAddAll, activityLog }) {
  return (
    <>
      {!apiConfigured && (
        <div className="conn-banner conn-off"><WifiOff size={15} /> No API base URL set yet. Add it in Settings once the HubSpot and Zoho routes are deployed — each source below will light up on its own.</div>
      )}
      {apiConfigured && (
        <div className="toolbar"><button className="btn btn-ghost btn-sm" onClick={onRefresh}><RefreshCw size={13} /> Refresh all</button></div>
      )}
      {SOURCES.map(s => {
        const sd = sourceData[s.key] || { status: "unconfigured", items: [] };
        const newItems = sd.items.filter(i => !findClientByEmail(i.email));
        const addedItems = sd.items.filter(i => findClientByEmail(i.email));
        // "Actions Taken" reuses the same activity log the rest of the CRM
        // already writes to (addFromCandidate logs "Added X from..." /
        // "Merged X data into..." on every action, and the Zoho/Beehiiv sync
        // job logs its own entries the same way) — filtered here to just
        // the entries that mention someone currently in this source, so it
        // works as a per-source history without needing a separate log.
        const sourceActions = (activityLog || []).filter(a => sd.items.some(i => i.email && a.text.includes(i.email)) || sd.items.some(i => i.name && a.text.includes(i.name)));
        return (
          <div key={s.key} style={{ marginBottom: 26 }}>
            <div className="section-title">
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}><s.icon size={14} /> {s.label} <Pill tone="slate">{s.system}</Pill></span>
              {sd.status === "live" && newItems.length > 0 && <button className="btn btn-gold btn-sm" onClick={() => onAddAll(s.key)}><UserPlus size={13} /> Add all new ({newItems.length})</button>}
            </div>

            {sd.status === "unconfigured" && <div className="card" style={{ padding: 16, fontSize: 12.5, color: "var(--slate)" }}>Not connected — expects <code>GET {"{base}"}{s.path}</code>.</div>}
            {sd.status === "checking" && <div className="card" style={{ padding: 16, fontSize: 12.5, color: "var(--slate)", display: "flex", alignItems: "center", gap: 8 }}><Loader2 size={14} className="spin" /> Checking…</div>}
            {sd.status === "error" && <div className="card" style={{ padding: 16, fontSize: 12.5, color: "var(--coral)" }}>Couldn't reach <code>{s.path}</code> at that base URL yet.</div>}

            {sd.status === "live" && (
              <>
                <CollapsibleGroup label="Imported" tone="navy" count={newItems.length} defaultOpen={newItems.length > 0}>
                  {newItems.length === 0 ? <div className="empty-state" style={{ padding: 16 }}>Nothing new to pull in right now.</div> : (
                    <table className="ctable">
                      <thead><tr><th>Name</th><th>Email</th><th>Detail</th><th></th></tr></thead>
                      <tbody>
                        {newItems.map((item, idx) => {
                          const detail = s.key === "assessments"
                            ? [item.tier, item.overallScore != null ? `${item.overallScore}%` : null].filter(Boolean).join(" · ")
                            : (item.campaignName || item.platform || "");
                          return (
                            <tr key={item.id || item.email || idx}>
                              <td className="client-name" style={{ fontSize: 13.5 }}>{item.name || "—"}</td>
                              <td style={{ fontSize: 12.5 }}>{item.email || "—"}</td>
                              <td style={{ fontSize: 12.5, color: "var(--slate)" }}>{detail || "—"}</td>
                              <td style={{ textAlign: "right" }}>
                                <button className="btn btn-gold btn-sm" onClick={() => onAdd(item, s.key)}><UserPlus size={12} /> Add as client</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </CollapsibleGroup>

                <CollapsibleGroup label="Added" tone="green" count={addedItems.length} defaultOpen={false}>
                  {addedItems.length === 0 ? <div className="empty-state" style={{ padding: 16 }}>None of these have been added as clients yet.</div> : (
                    <table className="ctable">
                      <thead><tr><th>Name</th><th>Email</th><th>Detail</th><th></th></tr></thead>
                      <tbody>
                        {addedItems.map((item, idx) => {
                          const existing = findClientByEmail(item.email);
                          const detail = s.key === "assessments"
                            ? [item.tier, item.overallScore != null ? `${item.overallScore}%` : null].filter(Boolean).join(" · ")
                            : (item.campaignName || item.platform || "");
                          return (
                            <tr key={item.id || item.email || idx}>
                              <td className="client-name" style={{ fontSize: 13.5 }}>{item.name || "—"}</td>
                              <td style={{ fontSize: 12.5 }}>{item.email || "—"}</td>
                              <td style={{ fontSize: 12.5, color: "var(--slate)" }}>{detail || "—"}</td>
                              <td style={{ textAlign: "right" }}>
                                <button className="btn btn-ghost btn-sm" onClick={() => onAdd(item, s.key)}><Check size={12} /> Merge into {existing?.name || "client"}</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </CollapsibleGroup>

                <CollapsibleGroup label="Actions taken" tone="slate" count={sourceActions.length} defaultOpen={false}>
                  {sourceActions.length === 0 ? <div className="empty-state" style={{ padding: 16 }}>No recorded actions for this source yet.</div> : sourceActions.map(a => (
                    <div className="activity-row" key={a.id}><span className="activity-dot" /><span>{a.text}</span><span className="activity-time">{timeAgo(a.ts)}</span></div>
                  ))}
                </CollapsibleGroup>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

// ---------- Settings ----------

function SettingsView({ zohoStatus, zohoError, onTest, team, onAddTeamMember, onRemoveTeamMember, emailTemplates, onAddTemplate, onRemoveTemplate, onPatchTemplate }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [role, setRole] = useState("");
  const [templateName, setTemplateName] = useState(""); const [templateBody, setTemplateBody] = useState("");
  function submitTemplate(e) {
    e.preventDefault();
    if (!templateName.trim() || !templateBody.trim()) return;
    onAddTemplate({ name: templateName.trim(), body: templateBody.trim() });
    setTemplateName(""); setTemplateBody("");
  }
  function submitTeam(e) {
    e.preventDefault();
    if (!name.trim()) return;
    onAddTeamMember({ name: name.trim(), email: email.trim(), role: role.trim() });
    setName(""); setEmail(""); setRole("");
  }
  return (
    <div className="card" style={{ padding: 22, maxWidth: 560 }}>
      <div className="section-title">Team</div>
      <p style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 0 }}>
        Add team members here so tasks can be assigned to a specific person, not just "client" vs "us."
      </p>
      <form onSubmit={submitTeam} style={{ marginBottom: 14 }}>
        <div className="field-row">
          <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Tracy" /></Field>
          <Field label="Role (optional)"><input value={role} onChange={e => setRole(e.target.value)} placeholder="e.g. Advisor" /></Field>
        </div>
        <Field label="Email (optional)"><input type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <button className="btn btn-primary btn-sm" type="submit"><Plus size={13} /> Add team member</button>
      </form>
      {(team || []).length === 0 ? <div className="empty-state" style={{ padding: 16 }}>No team members yet.</div> : (team || []).map(m => (
        <div className="task-row" key={m.id}>
          <div style={{ flex: 1 }}>
            <div className="task-title">{m.name}</div>
            <div className="task-meta">{m.role}{m.role && m.email ? " · " : ""}{m.email}</div>
          </div>
          <button className="btn-danger btn btn-sm" onClick={() => onRemoveTeamMember(m.id)}><Trash2 size={13} /></button>
        </div>
      ))}

      <div className="section-title" style={{ marginTop: 26 }}>Email templates</div>
      <p style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 0 }}>
        These are inspiration for the AI drafting agent, not fill-in-the-blank text — when a client emails in, the agent
        writes a genuine reply in the spirit of these templates rather than pasting them in verbatim.
      </p>
      <form onSubmit={submitTemplate} style={{ marginBottom: 14 }}>
        <Field label="Template name"><input value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="e.g. Following up after a strategy call" /></Field>
        <Field label="Body"><textarea rows={5} value={templateBody} onChange={e => setTemplateBody(e.target.value)} style={{ width: "100%", resize: "vertical" }} placeholder="Hi [First Name], great chatting today..." /></Field>
        <button className="btn btn-primary btn-sm" type="submit"><Plus size={13} /> Add template</button>
      </form>
      {(emailTemplates || []).length === 0 ? <div className="empty-state" style={{ padding: 16 }}>No templates yet.</div> : (emailTemplates || []).map(t => (
        <div className="task-row" key={t.id} style={{ alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <div className="task-title">{t.name}</div>
            <div className="task-meta" style={{ whiteSpace: "pre-wrap" }}>{t.body}</div>
          </div>
          <button className="btn-danger btn btn-sm" onClick={() => onRemoveTemplate(t.id)}><Trash2 size={13} /></button>
        </div>
      ))}

      <div className="section-title" style={{ marginTop: 26 }}>Zoho / HubSpot / Beehiiv connection</div>
      <p style={{ fontSize: 12.5, color: "var(--slate)", marginTop: 0 }}>
        This CRM is deployed alongside its own backend, so these routes are called automatically from the same domain —
        nothing to configure here. The backend holds your HubSpot private-app token and Zoho Client ID/Secret/refresh
        token server-side:
      </p>
      <ul style={{ fontSize: 12, color: "var(--slate)", paddingLeft: 18, marginTop: 0 }}>
        <li><code>GET /api/zoho/campaigns</code> — campaign performance: array of <code>{"{ id, name, platform, spend, leads, status, link }"}</code></li>
        <li><code>GET /api/hubspot/assessments</code> — completed assessments: <code>{"{ id, name, email, phone, company, path, overallScore, categories, topOpportunity, deliveryModel, completedAt }"}</code></li>
        <li><code>GET /api/zoho/leads/cpa</code> — CPA campaign responders: <code>{"{ id, name, email, phone, campaignName, campaignLink }"}</code></li>
        <li><code>GET /api/zoho/leads/social</code> — social campaign leads: same shape, plus <code>platform</code></li>
        <li><code>GET /api/zoho/leads/clicked</code> — anyone who clicked any campaign, aggregated: <code>{"{ id, name, email, campaignName, campaignLink, clickedAt }"}</code></li>
        <li><code>GET /api/beehiiv/subscribers</code> — newsletter subscribers from Beehiiv: <code>{"{ id, name, email, subscribedAt, link }"}</code> — needs a Beehiiv API key server-side, not Zoho</li>
      </ul>
      <p style={{ fontSize: 12, color: "var(--slate)" }}>Each route can return a plain array or <code>{"{ items: [...] }"}</code>. See the <b>Import</b> tab to pull in and add new people from these once they're live.</p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={onTest}><RefreshCw size={13} /> Test connection</button>
        {zohoStatus === "live" && <Pill tone="green">Connected</Pill>}
        {zohoStatus === "error" && <Pill tone="coral">Not reachable</Pill>}
        {zohoStatus === "checking" && <Pill tone="gold">Checking…</Pill>}
      </div>
      {zohoStatus === "error" && zohoError && (
        <div style={{ fontSize: 11.5, color: "var(--coral)", marginTop: 8, fontFamily: "monospace" }}>
          Error detail: {zohoError}
        </div>
      )}

      <div className="section-title" style={{ marginTop: 26 }}>Stripe payments</div>
      <p style={{ fontSize: 12.5, color: "var(--slate)" }}>
        Not connected yet, by design — revenue is logged manually for now in each client's Billing tab. When you're ready,
        the same backend can add a checkout route.
      </p>
    </div>
  );
}

// ---------- drawer tabs ----------

// Which of the 8 Zoho Campaigns tier lists a client is in, derived from
// their assessment path + tier rather than a separately-stored field —
// this always stays correct automatically as their assessment data
// changes, with no extra sync step needed.
function zohoListName(client) {
  const a = client.assessment;
  if (!a || !a.completed || !a.tier) return null;
  const prefix = a.path === "financial" ? "FP" : "General";
  return `${prefix} - ${a.tier}`;
}

function engagementEventMeta(type) {
  if (type === "click") return { label: "Email clicks", tone: "gold" };
  if (type === "open") return { label: "Email opens", tone: "navy" };
  if (type === "email_enrolled") return { label: "Nurture emails", tone: "green" };
  if (type === "email_received") return { label: "Emails from them", tone: "gold" };
  if (type === "email_sent") return { label: "Emails we sent", tone: "navy" };
  return { label: "Other activity", tone: "slate" };
}

// Combines two different data sources into one unified, grouped timeline:
//  1. Global activityLog entries that mention this client (same
//     name/email-matching heuristic used in the Import tab's "Actions
//     taken" section — there's no structured per-client link on log
//     entries, so text matching is what we have) — covers tasks, billing,
//     assessment completions, imports/merges.
//  2. client.engagementHistory — real per-contact email open/click events,
//     synced in from Zoho's Campaigns API (see lib/sync.js), plus a
//     guaranteed "enrolled in nurture list" event logged directly by
//     api/assessments/submit.js.
// NOTE: open/click tracking is confirmed working for regular Zoho
// Campaigns (CPA outreach, etc.) — it is NOT yet confirmed to work for the
// new tier-based nurture emails, since those send via Zoho Workflows, a
// different feature from Campaigns. Until that's verified, expect
// "Nurture emails" (enrollment) to be reliable, but "Email opens/clicks"
// on nurture emails specifically may not populate.
function ClientActivityTab({ client, activityLog }) {
  const relevantLog = useMemo(() => {
    if (!client.name && !client.email) return [];
    return (activityLog || []).filter(a => (client.email && a.text.includes(client.email)) || (client.name && a.text.includes(client.name)));
  }, [activityLog, client.name, client.email]);

  const combined = useMemo(() => {
    const fromLog = relevantLog.map(a => ({ id: a.id, ts: a.ts, text: a.text, ...categorizeActivity(a.text) }));
    const fromEngagement = (client.engagementHistory || []).map((e, i) => ({
      id: `eng_${i}_${e.ts}`, ts: e.ts,
      text: e.type === "email_enrolled" ? `Enrolled in ${e.campaignName}`
        : e.type === "email_received" ? `Emailed us: "${e.campaignName}"`
        : e.type === "email_sent" ? `We emailed them: "${e.campaignName}"`
        : `${e.type === "click" ? "Clicked" : "Opened"} "${e.campaignName}"`,
      // Deep link straight to the message in Gmail — only email events carry
      // a real Gmail messageId (campaign click/open events don't have one).
      // Uses account slot /u/0/ — if Tracy's elevatemy.ai account isn't the
      // first signed-in Google account in her browser, this may land on the
      // wrong account's inbox; there's no way to target a specific account
      // by email address in this URL format, only by slot position.
      gmailLink: (e.messageId && (e.type === "email_received" || e.type === "email_sent"))
        ? `https://mail.google.com/mail/u/0/#all/${e.messageId}`
        : null,
      ...engagementEventMeta(e.type),
    }));
    return [...fromLog, ...fromEngagement].sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  }, [relevantLog, client.engagementHistory]);

  const groups = useMemo(() => {
    const map = new Map();
    combined.forEach(item => {
      if (!map.has(item.label)) map.set(item.label, { label: item.label, tone: item.tone, items: [] });
      map.get(item.label).items.push(item);
    });
    return Array.from(map.values());
  }, [combined]);

  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 14 }}>
        Everything tied to this client — task completions, billing, assessment activity, imports, and real email opens/clicks synced from Zoho.
      </div>
      {groups.length === 0 ? (
        <div className="empty-state" style={{ padding: 20 }}>No activity recorded for this client yet.</div>
      ) : groups.map(g => (
        <CollapsibleGroup key={g.label} label={g.label} tone={g.tone} count={g.items.length}>
          {g.items.map(item => (
            <div className="activity-row" key={item.id}>
              <span className="activity-dot" />
              {item.gmailLink ? (
                <a href={item.gmailLink} target="_blank" rel="noopener noreferrer" title="Open in Gmail">{item.text}</a>
              ) : (
                <span>{item.text}</span>
              )}
              <span className="activity-time">{timeAgo(item.ts)}</span>
            </div>
          ))}
        </CollapsibleGroup>
      ))}
    </div>
  );
}

// Compose + send modal — calls the new /api/gmail/send endpoint, which
// sends through Gmail for real and logs the send against this client's
// record. Both tracy@ and matt@elevatemy.ai are selectable senders since
// matt@ is a "send mail as" alias on the same underlying Gmail account,
// not a separate connection.
function EmailComposer({ client, onCancel, onSent }) {
  const [from, setFrom] = useState("tracy@elevatemy.ai");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | error
  const [error, setError] = useState("");

  async function send() {
    if (!subject.trim() || !body.trim()) return;
    setStatus("sending"); setError("");
    try {
      const res = await fetch("/api/gmail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: client.email, from, subject: subject.trim(), body: body.trim(), clientId: client.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Send failed");
      onSent();
    } catch (e) {
      setStatus("error");
      setError(e.message);
    }
  }

  return (
    <div>
      <div className="display" style={{ fontSize: 18, marginBottom: 16 }}>Email {clientDisplayName(client)}</div>
      <div className="field-row">
        <Field label="To"><input value={client.email} disabled /></Field>
        <Field label="From">
          <select value={from} onChange={e => setFrom(e.target.value)}>
            <option value="tracy@elevatemy.ai">tracy@elevatemy.ai</option>
            <option value="matt@elevatemy.ai">matt@elevatemy.ai</option>
          </select>
        </Field>
      </div>
      <Field label="Subject"><input autoFocus value={subject} onChange={e => setSubject(e.target.value)} /></Field>
      <Field label="Message"><textarea rows={8} value={body} onChange={e => setBody(e.target.value)} style={{ width: "100%", resize: "vertical" }} /></Field>
      {status === "error" && <div style={{ fontSize: 12, color: "var(--coral)", marginBottom: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn btn-gold" disabled={status === "sending" || !subject.trim() || !body.trim()} onClick={send}>
          {status === "sending" ? <><Loader2 size={14} className="spin" /> Sending…</> : <><Send size={14} /> Send</>}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ProfileTab({ client, onPatch, onDelete, onComposeEmail }) {
  function patchName(patch) {
    const firstName = "firstName" in patch ? patch.firstName : (client.firstName || "");
    const lastName = "lastName" in patch ? patch.lastName : (client.lastName || "");
    onPatch({ ...patch, name: [firstName, lastName].filter(Boolean).join(" ") });
  }
  return (
    <div>
      <div className="field-row">
        <Field label="First name"><input value={client.firstName || ""} onChange={e => patchName({ firstName: e.target.value })} /></Field>
        <Field label="Last name"><input value={client.lastName || ""} onChange={e => patchName({ lastName: e.target.value })} /></Field>
      </div>
      <Field label="Company"><input value={client.company} onChange={e => onPatch({ company: e.target.value })} /></Field>
      <Field label="Business website"><input value={client.website || ""} onChange={e => onPatch({ website: e.target.value })} placeholder="https://theirbusiness.com" /></Field>
      <div className="field-row">
        <Field label="Email"><input value={client.email} onChange={e => onPatch({ email: e.target.value })} /></Field>
        <Field label="Phone"><input value={client.phone} onChange={e => onPatch({ phone: e.target.value })} /></Field>
      </div>
      <Field label="Status">
        <select value={client.status} onChange={e => onPatch({ status: e.target.value })}><option value="lead">Lead</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
      </Field>

      <div className="section-title" style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Links</span>
        {client.email && <button className="btn btn-gold btn-sm" onClick={onComposeEmail}><Mail size={13} /> Send email</button>}
      </div>
      <div className="card" style={{ padding: 12 }}>
        {(() => {
          const list = zohoListName(client);
          const links = [
            client.website && { label: "Business website", href: client.website },
            client.dashboard?.vercelUrl && { label: "Client site (built for them)", href: client.dashboard.vercelUrl },
            client.dashboard?.githubUrl && { label: "GitHub repo", href: client.dashboard.githubUrl },
          ].filter(Boolean);
          return (
            <>
              {links.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--slate)" }}>No links yet — add a business website above, or a client-site URL in the Dashboard tab.</div> : links.map(l => (
                <div key={l.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
                  <span style={{ fontSize: 12.5 }}>{l.label}</span>
                  <a href={l.href} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm"><ExternalLink size={12} /> Open</a>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: links.length ? "1px solid var(--slate-line)" : "none", marginTop: links.length ? 6 : 0 }}>
                <span style={{ fontSize: 12.5 }}>Zoho nurture list</span>
                {list ? <Pill tone="navy">{list}</Pill> : <span style={{ fontSize: 12, color: "var(--slate)" }}>Not on a list — no completed assessment yet</span>}
              </div>
            </>
          );
        })()}
      </div>
      <div style={{ marginTop: 20, borderTop: "1px solid var(--slate-line)", paddingTop: 16, display: "flex", gap: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => onPatch({ hidden: !client.hidden })}>
          {client.hidden ? <><Eye size={13} /> Unhide client</> : <><EyeOff size={13} /> Hide from main list</>}
        </button>
        <button className="btn btn-danger btn-sm" onClick={onDelete}><Trash2 size={13} /> Delete client</button>
      </div>
    </div>
  );
}

function AssessmentTab({ client, onPatch }) {
  const a = client.assessment || emptyAssessment();
  const cats = categoriesFor(a.path);
  const overall = computeOverall(a);
  const computedTier = gradeForScore(overall);
  const resolvedTier = a.tier || computedTier;
  const tierTone = { "AI-Ready": "green", "Emerging": "navy", "Building": "gold", "Exploring": "coral" }[resolvedTier] || "slate";

  function setCategory(key, val) {
    const nextCats = { ...a.categories, [key]: val };
    onPatch({ categories: nextCats });
  }

  return (
    <div>
      <div className="field-row">
        <Field label="Assessment path">
          <select value={a.path} onChange={e => onPatch({ path: e.target.value, categories: {} })}>
            <option value="general">General Business</option>
            <option value="financial">Financial Services</option>
          </select>
        </Field>
        <Field label="Completed?">
          <select value={a.completed ? "yes" : "no"} onChange={e => onPatch({ completed: e.target.value === "yes" })}>
            <option value="no">Not yet</option><option value="yes">Completed</option>
          </select>
        </Field>
        <Field label="Date"><input type="date" value={a.date} onChange={e => onPatch({ date: e.target.value })} /></Field>
      </div>

      <div className="score-ring" style={{ margin: "12px 0 18px" }}>
        <div className="score-num">{overall === null ? "—" : `${overall}%`}</div>
        <div>
          {resolvedTier && <Pill tone={tierTone}>{resolvedTier}</Pill>}
          <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 4 }}>
            {a.tier ? "Tier set explicitly (e.g. from HubSpot)" : "Auto-derived from category scores below"}
          </div>
        </div>
      </div>

      <Field label="Tier override" hint="Leave on Auto unless HubSpot/the live assessment reports a different tier than the category scores below compute.">
        <select value={a.tier} onChange={e => onPatch({ tier: e.target.value })}>
          <option value="">Auto ({computedTier || "—"})</option>
          <option value="Exploring">Exploring</option>
          <option value="Building">Building</option>
          <option value="Emerging">Emerging</option>
          <option value="AI-Ready">AI-Ready</option>
        </select>
      </Field>

      <div className="section-title">Category scores (0–100)</div>
      {cats.map(c => (
        <div className="cat-bar-row" key={c.key}>
          <div className="cat-bar-label"><span>{c.label}</span><span>{a.categories?.[c.key] ?? "—"}</span></div>
          <input type="range" min="0" max="100" value={a.categories?.[c.key] ?? 0} onChange={e => setCategory(c.key, Number(e.target.value))} style={{ width: "100%" }} />
        </div>
      ))}

      <div className="field-row" style={{ marginTop: 14 }}>
        <Field label="Delivery model">
          <select value={a.deliveryModel} onChange={e => onPatch({ deliveryModel: e.target.value })}>
            <option value="">Not set</option><option value="DIY">DIY</option><option value="Done-With-You">Done-With-You</option><option value="Full Setup">Full Setup / We Do It For You</option><option value="Custom Build">Custom Build</option>
          </select>
        </Field>
        <Field label="Consultation booked?">
          <select value={a.consultationBooked ? "yes" : "no"} onChange={e => onPatch({ consultationBooked: e.target.value === "yes" })}>
            <option value="no">Not booked</option><option value="yes">Booked</option>
          </select>
        </Field>
        {a.consultationBooked && <Field label="Consultation date"><input type="date" value={a.consultationDate} onChange={e => onPatch({ consultationDate: e.target.value })} /></Field>}
      </div>

      <Field label="Top opportunity"><input value={a.topOpportunity} onChange={e => onPatch({ topOpportunity: e.target.value })} placeholder="Biggest opportunity from the report" /></Field>
      <Field label="Notes"><textarea value={a.notes} onChange={e => onPatch({ notes: e.target.value })} /></Field>
    </div>
  );
}

function CampaignsTab({ client, onPatchNewsletter, onPatchZoho, onAddSocial, onPatchSocial, onRemoveSocial, apiConfigured }) {
  const n = client.newsletter || {}; const z = client.zoho || {};
  return (
    <div>
      <div className="section-title">Newsletter</div>
      <Field label="Subscribed?"><select value={n.subscribed ? "yes" : "no"} onChange={e => onPatchNewsletter({ subscribed: e.target.value === "yes" })}><option value="no">Not subscribed</option><option value="yes">Subscribed</option></select></Field>
      <Field label="Newsletter link"><input value={n.link} onChange={e => onPatchNewsletter({ link: e.target.value })} placeholder="https://…" /></Field>
      {n.link && <div className="link-row"><ExternalLink size={13} /><a href={n.link} target="_blank" rel="noreferrer">Open newsletter</a></div>}
      {(n.openRate != null || n.clickThroughRate != null) && (
        <div className="card" style={{ padding: 12, marginTop: 10, background: "var(--cloud)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--slate)", marginBottom: 8 }}>Beehiiv engagement</div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            {n.openRate != null && <div><div style={{ fontSize: 17, fontWeight: 700 }}>{Math.round(n.openRate * 100)}%</div><div style={{ fontSize: 11, color: "var(--slate)" }}>Open rate</div></div>}
            {n.clickThroughRate != null && <div><div style={{ fontSize: 17, fontWeight: 700 }}>{Math.round(n.clickThroughRate * 100)}%</div><div style={{ fontSize: 11, color: "var(--slate)" }}>Click-through rate</div></div>}
            {n.emailsReceived != null && <div><div style={{ fontSize: 17, fontWeight: 700 }}>{n.emailsReceived}</div><div style={{ fontSize: 11, color: "var(--slate)" }}>Emails received</div></div>}
          </div>
          <div style={{ fontSize: 10.5, color: "var(--slate)", marginTop: 8 }}>
            Lifetime aggregate across all newsletter sends — Beehiiv's API doesn't expose per-email timestamps, so this is as of last sync{n.statsAsOf ? ` (${fmtDate(n.statsAsOf.slice(0, 10))})` : ""}, not a specific click time.
          </div>
        </div>
      )}

      <div className="section-title" style={{ marginTop: 22 }}>Zoho Campaigns</div>
      <Field label="Campaign link"><input value={z.link} onChange={e => onPatchZoho({ link: e.target.value })} placeholder="https://campaigns.zoho.com/…" /></Field>
      <div className="field-row">
        <Field label="Status"><select value={z.status} onChange={e => onPatchZoho({ status: e.target.value })}><option value="not started">Not started</option><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option></select></Field>
        <Field label="Last sent"><input type="date" value={z.lastSent} onChange={e => onPatchZoho({ lastSent: e.target.value })} /></Field>
      </div>
      {z.link && <div className="link-row"><ExternalLink size={13} /><a href={z.link} target="_blank" rel="noreferrer">Open in Zoho</a></div>}
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginTop: 6 }}>
        {apiConfigured ? "Per-client live stats aren't wired up yet — check the Marketing tab for the live campaign feed." : "Manual for now — connect Zoho in Settings for live campaign data."}
      </div>

      <div className="section-title" style={{ marginTop: 22 }}>Social media campaigns</div>
      {(client.social || []).map(s => (
        <div key={s.id} className="card" style={{ padding: 12, marginBottom: 10 }}>
          <div className="field-row">
            <Field label="Platform"><select value={s.platform} onChange={e => onPatchSocial(s.id, { platform: e.target.value })}><option>Instagram</option><option>Facebook</option><option>LinkedIn</option><option>TikTok</option><option>X</option><option>YouTube</option></select></Field>
            <Field label="Status"><select value={s.status} onChange={e => onPatchSocial(s.id, { status: e.target.value })}><option value="not started">Not started</option><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option></select></Field>
          </div>
          <Field label="Campaign link"><input value={s.link} onChange={e => onPatchSocial(s.id, { link: e.target.value })} placeholder="https://…" /></Field>
          <button className="btn btn-danger btn-sm" onClick={() => onRemoveSocial(s.id)}><Trash2 size={12} /> Remove</button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={onAddSocial}><Plus size={13} /> Add social campaign</button>
    </div>
  );
}

function DashboardTab({ client, onPatch }) {
  const d = client.dashboard || {};
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 14 }}>Tracy's interview-built client dashboard (Vercel + GitHub). Link it here so it's one click away from the client record.</div>
      <Field label="Vercel dashboard URL"><input value={d.vercelUrl} onChange={e => onPatch({ vercelUrl: e.target.value })} placeholder="https://client-name.vercel.app" /></Field>
      {d.vercelUrl && <div className="link-row" style={{ marginBottom: 12 }}><Rocket size={13} /><a href={d.vercelUrl} target="_blank" rel="noreferrer">Open live dashboard</a></div>}
      <Field label="GitHub repo URL"><input value={d.githubUrl} onChange={e => onPatch({ githubUrl: e.target.value })} placeholder="https://github.com/…" /></Field>
      {d.githubUrl && <div className="link-row" style={{ marginBottom: 12 }}><Github size={13} /><a href={d.githubUrl} target="_blank" rel="noreferrer">Open repo</a></div>}
      <Field label="Last client interview"><input type="date" value={d.lastInterview} onChange={e => onPatch({ lastInterview: e.target.value })} /></Field>
      <Field label="Notes"><textarea value={d.notes} onChange={e => onPatch({ notes: e.target.value })} placeholder="Build notes, what the interview covered, next revision…" /></Field>
    </div>
  );
}

function ContractTab({ client, onPatch }) {
  const c = client.contract || {};
  const statusTone = c.status === "signed" ? "green" : c.status === "sent" ? "gold" : c.status === "expired" ? "coral" : "slate";
  const contactName = [client.firstName, client.lastName].filter(Boolean).join(" ") || client.name || "";

  function toggleSameAsContact(checked) {
    if (checked) {
      onPatch({ sameAsContact: true, signerName: contactName, signerEmail: client.email || "" });
    } else {
      onPatch({ sameAsContact: false });
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: "var(--slate)" }}>Everything needed to draft and send an engagement contract.</div>
        <Pill tone={statusTone}>{c.status || "draft"}</Pill>
      </div>

      <div className="section-title">Legal entity</div>
      <Field label="Legal business name"><input value={c.legalName} onChange={e => onPatch({ legalName: e.target.value })} placeholder="May differ from the company nickname used elsewhere" /></Field>
      <div className="field-row">
        <Field label="Entity type"><select value={c.entityType} onChange={e => onPatch({ entityType: e.target.value })}><option value="">Select…</option><option>Sole Proprietor</option><option>LLC</option><option>PC</option><option>S-Corp</option><option>C-Corp</option><option>Partnership</option><option>Other</option></select></Field>
      </div>
      <Field label="Business address"><textarea value={c.address} onChange={e => onPatch({ address: e.target.value })} /></Field>

      <div className="section-title" style={{ marginTop: 22 }}>Authorized signer</div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, marginBottom: 12, cursor: "pointer" }}>
        <input type="checkbox" checked={!!c.sameAsContact} onChange={e => toggleSameAsContact(e.target.checked)} />
        Same as contact ({contactName || "no name set"}{client.email ? `, ${client.email}` : ""})
      </label>
      <div className="field-row">
        <Field label="Signer name"><input value={c.signerName} disabled={c.sameAsContact} onChange={e => onPatch({ signerName: e.target.value })} /></Field>
        <Field label="Title"><input value={c.signerTitle} onChange={e => onPatch({ signerTitle: e.target.value })} placeholder="e.g. Owner, Managing Partner" /></Field>
      </div>
      <Field label="Signer email"><input type="email" value={c.signerEmail} disabled={c.sameAsContact} onChange={e => onPatch({ signerEmail: e.target.value })} /></Field>
      <div style={{ fontSize: 11, color: "var(--slate)", margin: "4px 0 10px" }}>If billing goes to someone else, add them below — otherwise leave blank.</div>
      <div className="field-row">
        <Field label="Billing contact name"><input value={c.billingContactName} onChange={e => onPatch({ billingContactName: e.target.value })} /></Field>
        <Field label="Billing contact email"><input type="email" value={c.billingContactEmail} onChange={e => onPatch({ billingContactEmail: e.target.value })} /></Field>
      </div>

      <div className="section-title" style={{ marginTop: 22 }}>Engagement terms</div>
      <Field label="Package / tier"><input value={c.package} onChange={e => onPatch({ package: e.target.value })} placeholder="e.g. AI Readiness Assessment + 3-month retainer" /></Field>
      <div className="field-row">
        <Field label="Effective date"><input type="date" value={c.effectiveDate} onChange={e => onPatch({ effectiveDate: e.target.value })} /></Field>
        <Field label="Term length"><input value={c.termLength} onChange={e => onPatch({ termLength: e.target.value })} placeholder="e.g. 12 months" /></Field>
      </div>
      <Field label="Auto-renews?"><select value={c.autoRenew ? "yes" : "no"} onChange={e => onPatch({ autoRenew: e.target.value === "yes" })}><option value="no">No</option><option value="yes">Yes</option></select></Field>
      <Field label="Scope of work"><textarea value={c.scopeNotes} onChange={e => onPatch({ scopeNotes: e.target.value })} placeholder="What's included in this engagement" /></Field>
      <div className="field-row">
        <Field label="Fee amount ($)"><input type="number" value={c.feeAmount} onChange={e => onPatch({ feeAmount: e.target.value })} /></Field>
        <Field label="Frequency"><select value={c.feeFrequency} onChange={e => onPatch({ feeFrequency: e.target.value })}><option value="one-time">One-time</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></Field>
      </div>
      <Field label="Payment terms"><input value={c.paymentTerms} onChange={e => onPatch({ paymentTerms: e.target.value })} placeholder="e.g. Due on signing, Net 30" /></Field>

      <div className="section-title" style={{ marginTop: 22 }}>Signature</div>
      <Field label="Status"><select value={c.status} onChange={e => onPatch({ status: e.target.value })}><option value="draft">Draft</option><option value="sent">Sent</option><option value="signed">Signed</option><option value="expired">Expired</option></select></Field>
      <Field label="E-signature link (e.g. DocuSign envelope)"><input value={c.signatureLink} onChange={e => onPatch({ signatureLink: e.target.value })} placeholder="https://…" /></Field>
      {c.signatureLink && <div className="link-row" style={{ marginBottom: 10 }}><ExternalLink size={13} /><a href={c.signatureLink} target="_blank" rel="noreferrer">Open signature request</a></div>}
      <div className="field-row">
        <Field label="Signed date"><input type="date" value={c.signedDate} onChange={e => onPatch({ signedDate: e.target.value })} /></Field>
        <Field label="Signed document link"><input value={c.signedDocLink} onChange={e => onPatch({ signedDocLink: e.target.value })} placeholder="https://…" /></Field>
      </div>
      {c.signedDocLink && <div className="link-row"><ExternalLink size={13} /><a href={c.signedDocLink} target="_blank" rel="noreferrer">Open signed document</a></div>}

      <div className="section-title" style={{ marginTop: 22 }}>Stripe <Pill tone="slate">not connected yet</Pill></div>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 10 }}>
        Manual for now — paste a Stripe Checkout or Payment Link here so it's one click away. Once Stripe is wired up on
        the backend, the customer and subscription IDs below can be filled in automatically instead.
      </div>
      <Field label="Stripe checkout / payment link"><input value={c.stripeCheckoutLink} onChange={e => onPatch({ stripeCheckoutLink: e.target.value })} placeholder="https://buy.stripe.com/…" /></Field>
      {c.stripeCheckoutLink && <div className="link-row" style={{ marginBottom: 10 }}><ExternalLink size={13} /><a href={c.stripeCheckoutLink} target="_blank" rel="noreferrer">Open Stripe checkout</a></div>}
      <div className="field-row">
        <Field label="Stripe customer ID" hint="Filled automatically once Stripe is connected"><input value={c.stripeCustomerId} onChange={e => onPatch({ stripeCustomerId: e.target.value })} placeholder="cus_…" /></Field>
        <Field label="Stripe subscription ID" hint="Filled automatically once Stripe is connected"><input value={c.stripeSubscriptionId} onChange={e => onPatch({ stripeSubscriptionId: e.target.value })} placeholder="sub_…" /></Field>
      </div>
    </div>
  );
}


function BillingTab({ client, onAdd, onPatch, onRemove, onPatchClient }) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("paid");
  const [method, setMethod] = useState("Invoice");
  const [date, setDate] = useState(todayISO());
  const [stripeLink, setStripeLink] = useState("");
  const entries = client.billing || [];
  const total = entries.filter(e => e.status === "paid").reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const pending = entries.filter(e => e.status !== "paid").reduce((s, e) => s + (Number(e.amount) || 0), 0);

  function submit(e) {
    e.preventDefault();
    if (!amount) return;
    onAdd({ amount, description, status, method, date, stripeLink });
    setAmount(""); setDescription(""); setStripeLink("");
  }

  return (
    <div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, marginBottom: 14, cursor: "pointer" }}>
        <input type="checkbox" checked={!!client.proBono} onChange={e => onPatchClient({ proBono: e.target.checked })} />
        Pro-bono client — no fee expected (hides the "Payment Due" pill even if nothing's logged yet)
      </label>
      <div className="stat-grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 18 }}>
        <StatCard label="Paid to date" value={fmtMoney(total)} icon={DollarSign} tone="green" />
        <StatCard label="Pending" value={fmtMoney(pending)} icon={CreditCard} tone="gold" />
      </div>
      <div style={{ fontSize: 11.5, color: "var(--slate)", marginBottom: 14 }}>
        Logged manually for now. If you have a Stripe Payment Link for this client, save it here so it's one click away — actual charge processing needs a backend, same as the Zoho connection.
      </div>
      <form onSubmit={submit} className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div className="field-row">
          <Field label="Amount ($)"><input type="number" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
          <Field label="Date"><input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        </div>
        <Field label="Description"><input value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Setup fee, Month 1 retainer" /></Field>
        <div className="field-row">
          <Field label="Status"><select value={status} onChange={e => setStatus(e.target.value)}><option value="paid">Paid</option><option value="pending">Pending</option><option value="overdue">Overdue</option></select></Field>
          <Field label="Method"><select value={method} onChange={e => setMethod(e.target.value)}><option>Invoice</option><option>Stripe</option><option>ACH</option><option>Check</option><option>Other</option></select></Field>
        </div>
        <Field label="Stripe payment link (optional)"><input value={stripeLink} onChange={e => setStripeLink(e.target.value)} placeholder="https://buy.stripe.com/…" /></Field>
        <button className="btn btn-primary btn-sm" type="submit"><Plus size={13} /> Log payment</button>
      </form>
      {entries.length === 0 ? <div className="empty-state" style={{ padding: 20 }}>No billing history yet.</div> : entries.map(e => (
        <div className="task-row" key={e.id}>
          <div style={{ flex: 1 }}>
            <div className="task-title">{e.description || "Payment"} — {fmtMoney(e.amount)}</div>
            <div className="task-meta"><Calendar size={11} /> {fmtDate(e.date)} · {e.method}{e.stripeLink && <> · <a href={e.stripeLink} target="_blank" rel="noreferrer">link</a></>}</div>
          </div>
          <Pill tone={e.status === "paid" ? "green" : e.status === "overdue" ? "coral" : "gold"}>{e.status}</Pill>
          <button className="btn-danger btn btn-sm" onClick={() => onRemove(e.id)}><Trash2 size={13} /></button>
        </div>
      ))}
    </div>
  );
}

function ClientTasksTab({ client, team, onAdd, onToggle, onRemove, onPatch }) {
  const [title, setTitle] = useState(""); const [owner, setOwner] = useState("client"); const [due, setDue] = useState(""); const [assignedTo, setAssignedTo] = useState("");
  const [blockStart, setBlockStart] = useState(""); const [blockEnd, setBlockEnd] = useState("");
  const tasks = client.tasks || [];
  function submit(e) { e.preventDefault(); if (!title.trim()) return; onAdd({ title: title.trim(), owner, dueDate: due, assignedTo: assignedTo || null, blockStart: blockStart || "", blockEnd: blockEnd || "" }); setTitle(""); setDue(""); setAssignedTo(""); setBlockStart(""); setBlockEnd(""); }
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 14 }}>Track what keeps this client's campaign moving — tasks the client owes us, and tasks we owe the client.</div>
      <form onSubmit={submit} className="card" style={{ padding: 14, marginBottom: 16 }}>
        <Field label="Task"><input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Send logo files" /></Field>
        <div className="field-row">
          <Field label="Owed by"><select value={owner} onChange={e => setOwner(e.target.value)}><option value="client">Client</option><option value="team">Us</option></select></Field>
          <Field label="Due date"><input type="date" value={due} onChange={e => setDue(e.target.value)} /></Field>
        </div>
        <div className="field-row">
          <Field label="Work on it starting"><input type="date" value={blockStart} onChange={e => setBlockStart(e.target.value)} /></Field>
          <Field label="Work on it by (block end)"><input type="date" value={blockEnd} onChange={e => setBlockEnd(e.target.value)} /></Field>
        </div>
        <Field label="Assigned to">
          <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)}>
            <option value="">Unassigned</option>
            {(team || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <button className="btn btn-primary btn-sm" type="submit"><Plus size={13} /> Add task</button>
      </form>
      {tasks.length === 0 ? <div className="empty-state" style={{ padding: 20 }}>No tasks yet.</div> : tasks.map(t => (
        <div className="task-row" key={t.id}>
          <span className="task-check" onClick={() => onToggle(t.id)}>{t.status === "done" ? <CheckCircle2 size={16} /> : <Circle size={16} />}</span>
          <div style={{ flex: 1 }}>
            <div className={"task-title" + (t.status === "done" ? " done" : "")}>{t.title}</div>
            <div className="task-meta" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <select
                value={t.owner === "client" ? "client" : "team"}
                onChange={e => onPatch(t.id, { owner: e.target.value })}
                style={{ fontSize: 11, padding: "2px 6px", borderRadius: 999, border: "none", fontWeight: 700, cursor: "pointer", background: t.owner === "client" ? "var(--gold-bg, #FDF3D9)" : "var(--navy-bg, #E4E9F0)", color: t.owner === "client" ? "var(--gold-dark, #8A6D00)" : "var(--navy)" }}
              >
                <option value="client">client owes</option>
                <option value="team">we owe</option>
              </select>
              <select
                value={t.assignedTo || ""}
                onChange={e => onPatch(t.id, { assignedTo: e.target.value || null })}
                style={{ fontSize: 11, padding: "2px 6px", borderRadius: 999, border: "1px solid var(--slate-line)", cursor: "pointer", background: "#fff", color: "var(--slate)" }}
              >
                <option value="">Unassigned</option>
                {(team || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              {t.dueDate && <span>· <Calendar size={11} /> {fmtDate(t.dueDate)}</span>}
              {t.blockStart && <span>· <Clock size={11} /> work {fmtDate(t.blockStart)}–{fmtDate(t.blockEnd)}</span>}
            </div>
          </div>
          {isOverdue(t) && <Pill tone="coral">overdue</Pill>}
          <button className="btn-danger btn btn-sm" onClick={() => onRemove(t.id)}><Trash2 size={13} /></button>
        </div>
      ))}
    </div>
  );
}

function AddClientForm({ onCancel, onSave }) {
  const [firstName, setFirstName] = useState(""); const [lastName, setLastName] = useState(""); const [company, setCompany] = useState(""); const [email, setEmail] = useState("");
  const [phone, setPhone] = useState(""); const [status, setStatus] = useState("lead");
  function submit(e) {
    e.preventDefault();
    if (!firstName.trim() && !lastName.trim()) return;
    const name = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");
    onSave({ firstName: firstName.trim(), lastName: lastName.trim(), name, company, email, phone, status });
  }
  return (
    <form onSubmit={submit}>
      <div className="display" style={{ fontSize: 18, marginBottom: 16 }}>Add a client</div>
      <div className="field-row">
        <Field label="First name"><input autoFocus value={firstName} onChange={e => setFirstName(e.target.value)} /></Field>
        <Field label="Last name"><input value={lastName} onChange={e => setLastName(e.target.value)} /></Field>
      </div>
      <Field label="Company"><input value={company} onChange={e => setCompany(e.target.value)} /></Field>
      <div className="field-row">
        <Field label="Email"><input type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Phone"><input value={phone} onChange={e => setPhone(e.target.value)} /></Field>
      </div>
      <Field label="Status"><select value={status} onChange={e => setStatus(e.target.value)}><option value="lead">Lead</option><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <button type="submit" className="btn btn-gold"><Save size={14} /> Save client</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
