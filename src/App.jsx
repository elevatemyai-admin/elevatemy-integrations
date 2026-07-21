import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  LayoutDashboard, Users, ListChecks, Plus, Search, X, ExternalLink, Github, Rocket,
  Newspaper, Share2, ClipboardCheck, CheckCircle2, Circle, AlertTriangle, Trash2,
  ChevronRight, Save, Loader2, Calendar, User, Users2, DollarSign, Megaphone,
  Settings as SettingsIcon, RefreshCw, Wifi, WifiOff, TrendingUp, CreditCard, Activity,
  Inbox, UserPlus, Check, Send, FileSignature, Eye, EyeOff
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
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle");

  const [view, setView] = useState("overview");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showHidden, setShowHidden] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [detailTab, setDetailTab] = useState("profile");
  const [showAddModal, setShowAddModal] = useState(false);
  const [taskOwnerFilter, setTaskOwnerFilter] = useState("all");
  const [taskAssigneeFilter, setTaskAssigneeFilter] = useState("all");

  const [zohoLive, setZohoLive] = useState([]);
  const [zohoStatus, setZohoStatus] = useState("unconfigured"); // unconfigured | checking | live | error
  const [zohoError, setZohoError] = useState("");
  const [sourceData, setSourceData] = useState(() => Object.fromEntries(SOURCES.map(s => [s.key, { status: "unconfigured", items: [] }])));

  useEffect(() => {
    (async () => {
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
        }
      } catch (e) { /* first run — nothing stored yet */ }
      finally { setLoading(false); }
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setSaveState("saving");
    try {
      const res = await fetch("/api/crm/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      setSaveState(res.ok ? "saved" : "error");
    } catch (e) { setSaveState("error"); }
    setTimeout(() => setSaveState(s => s === "saving" ? s : "idle"), 1400);
  }, []);

  const snapshot = useCallback((overrides = {}) => ({
    clients, marketingCampaigns, activityLog, team, ...overrides,
  }), [clients, marketingCampaigns, activityLog, team]);

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
    { key: "tasks", label: "Tasks & Campaigns", icon: ListChecks },
    { key: "marketing", label: "Marketing", icon: Megaphone },
    { key: "settings", label: "Settings", icon: SettingsIcon },
  ];

  return (
    <div className="crm-root">
      <style>{`
        .crm-root {
          --ink:#161B22; --navy:#1B2430; --navy-soft:#232E3E; --cloud:#F5F6F4; --cloud-dim:#ECEEEA;
          --card:#FFFFFF; --gold:#E8A33D; --gold-soft:#FBEBD2; --green:#4C7A5E; --green-soft:#E1EBE4;
          --coral:#C7554F; --coral-soft:#F5DEDC; --slate:#6B7280; --slate-line:#DADEE3;
          font-family:'Inter',-apple-system,sans-serif; background:var(--cloud); color:var(--ink);
          min-height:100vh; display:flex; border-radius:12px; overflow:hidden;
        }
        .crm-root * { box-sizing:border-box; }
        .display { font-family:'Fraunces', Georgia, serif; }
        .sidebar { width:220px; flex-shrink:0; background:var(--navy); color:#E7EAEE; display:flex; flex-direction:column; padding:20px 14px; }
        .brand { display:flex; align-items:center; gap:10px; padding:6px 8px 22px; }
        .brand-mark { width:30px; height:30px; border-radius:8px; background:linear-gradient(145deg,var(--gold),#C97F1F); display:flex; align-items:center; justify-content:center; color:#1B2430; font-weight:700; font-size:14px; }
        .brand-name { font-size:15px; font-weight:600; }
        .brand-sub { font-size:10.5px; color:#9AA5B1; margin-top:1px; }
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
          <div className="brand-mark">EM</div>
          <div><div className="brand-name">Elevatemy.ai</div><div className="brand-sub">Client CRM</div></div>
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
              {view === "settings" && "Settings"}
            </h1>
            <p>
              {view === "overview" && "Current activity, revenue, and prospecting at a glance."}
              {view === "clients" && "Assessments, newsletter, Zoho, social, billing, and client dashboards — all in one record."}
              {view === "import" && "Pull in assessment takers, campaign responders, and subscribers from your connected systems."}
              {view === "tasks" && "What clients owe us, and what we owe clients."}
              {view === "marketing" && "CPA campaigns and prospecting activity, live from Zoho once connected."}
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
              clients={clients} revenue={revenue} activityLog={activityLog}
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
            <ImportView sourceData={sourceData} onRefresh={checkSources} apiConfigured={true}
              findClientByEmail={findClientByEmail} onAdd={addFromCandidate} onAddAll={addAllNew} />
          ) : view === "tasks" ? (
            <TasksView tasks={allTasks} ownerFilter={taskOwnerFilter} setOwnerFilter={setTaskOwnerFilter}
              team={team} assigneeFilter={taskAssigneeFilter} setAssigneeFilter={setTaskAssigneeFilter}
              onToggle={(cid, tid) => toggleTask(cid, tid)} onOpenClient={(id) => { setSelectedId(id); setView("clients"); setDetailTab("tasks"); }} />
          ) : view === "marketing" ? (
            <MarketingView campaigns={marketingCampaigns} zohoLive={zohoLive} zohoStatus={zohoStatus} onRefresh={checkZoho}
              onAdd={addCampaign} onPatch={patchCampaign} onRemove={removeCampaign} apiConfigured={true} />
          ) : (
            <SettingsView zohoStatus={zohoStatus} zohoError={zohoError} onTest={checkZoho} team={team} onAddTeamMember={addTeamMember} onRemoveTeamMember={removeTeamMember} />
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
              ].map(t => (
                <div key={t.k} className={"tab" + (detailTab === t.k ? " active" : "")} onClick={() => setDetailTab(t.k)}><t.icon size={13} /> {t.label}</div>
              ))}
            </div>
            <div className="drawer-body">
              {detailTab === "profile" && <ProfileTab client={selectedClient} onPatch={(p) => patchClient(selectedClient.id, p)} onDelete={() => deleteClient(selectedClient.id)} />}
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
            </div>
          </div>
        </div>
      )}

      {showAddModal && (
        <div className="overlay center" onClick={(e) => { if (e.target === e.currentTarget) setShowAddModal(false); }}>
          <div className="modal"><AddClientForm onCancel={() => setShowAddModal(false)} onSave={(data) => { addClient(data); setShowAddModal(false); }} /></div>
        </div>
      )}
    </div>
  );
}

// ---------- Overview / Dashboard ----------

function OverviewView({ clients, revenue, activityLog, assessedCount, activeCampaignCount, overdueCount, marketingCampaigns, zohoLive, zohoStatus, onOpen }) {
  const upcoming = useMemo(() => {
    const list = [];
    clients.forEach(c => (c.tasks || []).forEach(t => { if (t.status !== "done") list.push({ ...t, clientName: clientDisplayName(c) }); }));
    return list.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999")).slice(0, 6);
  }, [clients]);

  const marketing = zohoStatus === "live" ? zohoLive : marketingCampaigns;
  const totalSpend = marketing.reduce((s, c) => s + (Number(c.spend) || 0), 0);
  const totalLeads = marketing.reduce((s, c) => s + (Number(c.leads) || 0), 0);
  const blendedCpa = totalLeads ? totalSpend / totalLeads : 0;

  return (
    <>
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
          <div className="card" style={{ padding: "6px 16px" }}>
            {upcoming.length === 0 ? <div className="empty-state" style={{ padding: 24 }}>Nothing on the horizon.</div> : upcoming.map(t => (
              <div className="task-row" key={t.id}>
                <span className="task-check"><Circle size={16} /></span>
                <div style={{ flex: 1 }}>
                  <div className="task-title">{t.title}</div>
                  <div className="task-meta"><User size={11} /> {t.clientName} · owed by {t.owner === "client" ? "client" : "us"}</div>
                </div>
                <Pill tone={isOverdue(t) ? "coral" : "slate"}>{fmtDate(t.dueDate)}</Pill>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="section-title">Current activity</div>
          <div className="card" style={{ padding: "6px 16px", marginBottom: 24 }}>
            {activityLog.length === 0 ? <div className="empty-state" style={{ padding: 24 }}>Activity will show up here as you use the CRM.</div> : activityLog.slice(0, 10).map(a => (
              <div className="activity-row" key={a.id}><span className="activity-dot" /><span>{a.text}</span><span className="activity-time">{timeAgo(a.ts)}</span></div>
            ))}
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
      <div className="card" style={{ padding: "6px 16px" }}>
        {filtered.length === 0 ? <div className="empty-state"><div className="display">No tasks yet</div>Add tasks from a client's Tasks tab to track campaigns that keep everyone on track.</div> : filtered.map(t => (
          <div className="task-row" key={t.id + t.clientId}>
            <span className="task-check" onClick={() => onToggle(t.clientId, t.id)}>{t.status === "done" ? <CheckCircle2 size={16} /> : <Circle size={16} />}</span>
            <div style={{ flex: 1, cursor: "pointer" }} onClick={() => onOpenClient(t.clientId)}>
              <div className={"task-title" + (t.status === "done" ? " done" : "")}>{t.title}</div>
              <div className="task-meta"><User size={11} /> {t.clientName} · <Pill tone={t.owner === "client" ? "gold" : "navy"}>{t.owner === "client" ? "client owes" : "we owe"}</Pill> {t.assignedTo && memberName(t.assignedTo) && <Pill tone="slate">{memberName(t.assignedTo)}</Pill>}</div>
            </div>
            {t.dueDate && <Pill tone={isOverdue(t) ? "coral" : "slate"}>{fmtDate(t.dueDate)}</Pill>}
          </div>
        ))}
      </div>
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

// ---------- Import ----------

function ImportView({ sourceData, onRefresh, apiConfigured, findClientByEmail, onAdd, onAddAll }) {
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
        const newCount = sd.items.filter(i => !findClientByEmail(i.email)).length;
        return (
          <div key={s.key} style={{ marginBottom: 26 }}>
            <div className="section-title">
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}><s.icon size={14} /> {s.label} <Pill tone="slate">{s.system}</Pill></span>
              {sd.status === "live" && newCount > 0 && <button className="btn btn-gold btn-sm" onClick={() => onAddAll(s.key)}><UserPlus size={13} /> Add all new ({newCount})</button>}
            </div>
            <div className="card" style={{ padding: sd.items.length ? 8 : 16 }}>
              {sd.status === "unconfigured" && <div style={{ padding: 16, fontSize: 12.5, color: "var(--slate)" }}>Not connected — expects <code>GET {"{base}"}{s.path}</code>.</div>}
              {sd.status === "checking" && <div style={{ padding: 16, fontSize: 12.5, color: "var(--slate)", display: "flex", alignItems: "center", gap: 8 }}><Loader2 size={14} className="spin" /> Checking…</div>}
              {sd.status === "error" && <div style={{ padding: 16, fontSize: 12.5, color: "var(--coral)" }}>Couldn't reach <code>{s.path}</code> at that base URL yet.</div>}
              {sd.status === "live" && sd.items.length === 0 && <div style={{ padding: 16, fontSize: 12.5, color: "var(--slate)" }}>Connected — nothing new to pull in right now.</div>}
              {sd.status === "live" && sd.items.length > 0 && (
                <table className="ctable">
                  <thead><tr><th>Name</th><th>Email</th><th>Detail</th><th></th></tr></thead>
                  <tbody>
                    {sd.items.map((item, idx) => {
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
                            {existing ? (
                              <button className="btn btn-ghost btn-sm" onClick={() => onAdd(item, s.key)}><Check size={12} /> Merge into {existing.name || "client"}</button>
                            ) : (
                              <button className="btn btn-gold btn-sm" onClick={() => onAdd(item, s.key)}><UserPlus size={12} /> Add as client</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ---------- Settings ----------

function SettingsView({ zohoStatus, zohoError, onTest, team, onAddTeamMember, onRemoveTeamMember }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [role, setRole] = useState("");
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

function ProfileTab({ client, onPatch, onDelete }) {
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
      <div className="field-row">
        <Field label="Email"><input value={client.email} onChange={e => onPatch({ email: e.target.value })} /></Field>
        <Field label="Phone"><input value={client.phone} onChange={e => onPatch({ phone: e.target.value })} /></Field>
      </div>
      <Field label="Status">
        <select value={client.status} onChange={e => onPatch({ status: e.target.value })}><option value="lead">Lead</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
      </Field>
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
  const tasks = client.tasks || [];
  function submit(e) { e.preventDefault(); if (!title.trim()) return; onAdd({ title: title.trim(), owner, dueDate: due, assignedTo: assignedTo || null }); setTitle(""); setDue(""); setAssignedTo(""); }
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 14 }}>Track what keeps this client's campaign moving — tasks the client owes us, and tasks we owe the client.</div>
      <form onSubmit={submit} className="card" style={{ padding: 14, marginBottom: 16 }}>
        <Field label="Task"><input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Send logo files" /></Field>
        <div className="field-row">
          <Field label="Owed by"><select value={owner} onChange={e => setOwner(e.target.value)}><option value="client">Client</option><option value="team">Us</option></select></Field>
          <Field label="Due date"><input type="date" value={due} onChange={e => setDue(e.target.value)} /></Field>
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
