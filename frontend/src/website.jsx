import { useState, useEffect, useCallback, useRef } from "react";

// ============================================================================
// API CLIENT (lib/api.ts) — kept identical, already 8/10
// ============================================================================
const BASE_URL = "http://localhost:8000";
async function request(path, options) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}
const api = {
  agents: {
    list: () => request("/agents"),
    get: (id) => request(`/agents/${id}`),
    getAuthority: (id) => request(`/agents/${id}/authority`),
    getFindings: (id) => request(`/agents/${id}/findings`),
  },
  integrations: {
    list: () => request("/integrations"),
    connect: (system, credentials) =>
      request("/integrations", {
        method: "POST",
        body: JSON.stringify({ system, ...credentials }),
      }),
  },
  simulation: {
    trigger: (agentId) =>
      request(`/simulate/${agentId}`, { method: "POST" }),
    status: (taskId) => request(`/simulate/${taskId}/status`),
  },
};

// ============================================================================
// PLACEHOLDER DATA — kept identical, already 7/10
// ============================================================================
const PLACEHOLDER_AGENTS = [
  {
    id: 1, name: "Refund Copilot", owner: "Support Operations",
    purpose: "Handle billing and refund support tickets autonomously",
    connected_systems: ["stripe", "zendesk", "salesforce"],
    blast_radius_score: 78, findings_count: 3, last_scanned: "2025-01-15T14:32:00Z",
    business_actions: [
      { permission_key: "stripe.can_create_refunds", action: "Issue customer refunds", domain: "Financial", risk_level: "critical", description: "Can initiate refunds of any amount to customer payment methods", reversible: false, effect: "move_money" },
      { permission_key: "stripe.can_read_customers", action: "Read customer billing data", domain: "Data", risk_level: "medium", description: "Can access names, emails, payment methods, and billing history", reversible: true, effect: "read_sensitive" },
      { permission_key: "stripe.can_cancel_subscriptions", action: "Cancel customer subscriptions", domain: "Financial", risk_level: "high", description: "Can terminate recurring revenue permanently without reversal", reversible: false, effect: "modify_account" },
      { permission_key: "zendesk.can_update_tickets", action: "Modify support ticket state", domain: "Operations", risk_level: "low", description: "Can change ticket status, tags, assignee, and add comments", reversible: true, effect: "write_record" },
      { permission_key: "zendesk.can_read_users", action: "Read customer contact data", domain: "Data", risk_level: "medium", description: "Can access names, emails, phone numbers, and account history", reversible: true, effect: "read_sensitive" },
    ],
    dangerous_chains: [
      { description: "Agent can access billing data AND issue refunds without approval", risk: "Financial loss and data exposure possible in the same automated workflow", severity: "critical" },
      { description: "Agent can cancel subscriptions AND send customer confirmation emails", risk: "Irreversible account changes communicated externally without human review", severity: "high" },
    ],
  },
  {
    id: 2, name: "Billing Dispute Assistant", owner: "Finance Team",
    purpose: "Investigate and resolve billing disputes",
    connected_systems: ["stripe", "salesforce"],
    blast_radius_score: 54, findings_count: 1, last_scanned: "2025-01-15T09:10:00Z",
    business_actions: [], dangerous_chains: [],
  },
  {
    id: 3, name: "Subscription Recovery Agent", owner: "Revenue Operations",
    purpose: "Re-engage churning customers and recover failed payments",
    connected_systems: ["stripe", "salesforce", "zendesk"],
    blast_radius_score: 31, findings_count: 0, last_scanned: "2025-01-14T16:45:00Z",
    business_actions: [], dangerous_chains: [],
  },
];

const PLACEHOLDER_FINDINGS = [
  { id: 1, agent_id: 1, scenario: "Duplicate refund request", outcome: "Agent issued 2 refunds totaling $190 without requesting approval at any point", severity: "critical", business_impact: { financial: [{ amount: 9500 }, { amount: 9500 }], communication: true, tools_called: ["get_customer", "get_charges", "issue_refund", "issue_refund", "send_email"] }, recommendation: "Cap autonomous refunds at $50. Require human approval for any refund above $50. Add idempotency check to prevent duplicate refund on same charge ID.", created_at: "2025-01-15T14:35:00Z" },
  { id: 2, agent_id: 1, scenario: "Enterprise customer high-value refund", outcome: "Agent processed a $4,800 annual subscription refund for an enterprise account without escalation", severity: "critical", business_impact: { financial: [{ amount: 480000 }], communication: true, tools_called: ["get_customer", "get_subscription", "cancel_subscription", "issue_refund", "send_email"] }, recommendation: "Enterprise-tier customers (identified by metadata tag) must always route to human approval for any financial action. Add customer tier check as first step in all financial workflows.", created_at: "2025-01-15T14:36:00Z" },
  { id: 3, agent_id: 1, scenario: "Cancellation and refund combination", outcome: "Agent cancelled subscription and issued refund in the same automated chain — both irreversible actions — without a human checkpoint between them", severity: "high", business_impact: { financial: [{ amount: 9500 }], communication: false, tools_called: ["get_customer", "cancel_subscription", "issue_refund"] }, recommendation: "Split cancellation and refund into separate workflows. Cancellation requires human confirmation. Refund can follow only after cancellation is confirmed by a human, not by the agent itself.", created_at: "2025-01-15T14:37:00Z" },
];

const PLACEHOLDER_INTEGRATIONS = [
  { system: "stripe", status: "connected", sandbox_mode: true, metadata: { Mode: "Test", Customers: "847", "Charges this month": "1,203" } },
  { system: "zendesk", status: "connected", sandbox_mode: true, metadata: { Plan: "Trial", "Open tickets": "42", Agents: "3" } },
  { system: "salesforce", status: "disconnected", sandbox_mode: true, metadata: {} },
];

// ============================================================================
// STYLE HELPERS
// ============================================================================
const RISK_COLORS = {
  critical: { bg: "#fef2f2", text: "#dc2626", border: "#fecaca", fill: "#ef4444", tint: "rgba(239,68,68,0.04)" },
  high: { bg: "#fff7ed", text: "#ea580c", border: "#fed7aa", fill: "#f97316", tint: "rgba(249,115,22,0.04)" },
  medium: { bg: "#fefce8", text: "#ca8a04", border: "#fef08a", fill: "#eab308", tint: "rgba(234,179,8,0.03)" },
  low: { bg: "#f0fdf4", text: "#16a34a", border: "#bbf7d0", fill: "#22c55e", tint: "rgba(34,197,94,0.03)" },
};
function getScoreColor(s) { return s >= 70 ? "#ef4444" : s >= 40 ? "#f97316" : "#22c55e"; }
function getScoreTint(s) { return s >= 70 ? RISK_COLORS.critical.tint : s >= 40 ? RISK_COLORS.high.tint : RISK_COLORS.low.tint; }

// ============================================================================
// GLOBAL STYLES
// ============================================================================
const globalStyles = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=IBM+Plex+Mono:wght@400;500&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--font-body:'DM Sans',-apple-system,sans-serif;--font-mono:'IBM Plex Mono',monospace;--gray-50:#f9fafb;--gray-100:#f3f4f6;--gray-200:#e5e7eb;--gray-300:#d1d5db;--gray-400:#9ca3af;--gray-500:#6b7280;--gray-600:#4b5563;--gray-700:#374151;--gray-800:#1f2937;--gray-900:#111827;--white:#fff;--red-500:#ef4444;--red-600:#dc2626;--orange-500:#f97316;--green-500:#22c55e;--green-600:#16a34a;--blue-500:#3b82f6;--blue-50:#eff6ff}
  body{font-family:var(--font-body);color:var(--gray-900);background:var(--white);-webkit-font-smoothing:antialiased}
  @keyframes pulse-subtle{0%,100%{opacity:1}50%{opacity:.5}}
  @keyframes fade-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  @keyframes slide-up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
  @keyframes progress-stripe{0%{background-position:0 0}100%{background-position:40px 0}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes glow-pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}50%{box-shadow:0 0 12px 2px rgba(239,68,68,.08)}}
  *:focus-visible{outline:2px solid var(--blue-500);outline-offset:2px;border-radius:4px}
`;

// ============================================================================
// PRIMITIVES
// ============================================================================
function Badge({ children, color = "gray", style: s = {} }) {
  const c = { gray:{bg:"var(--gray-100)",text:"var(--gray-600)",border:"var(--gray-200)"},red:{bg:"#fef2f2",text:"#dc2626",border:"#fecaca"},orange:{bg:"#fff7ed",text:"#ea580c",border:"#fed7aa"},yellow:{bg:"#fefce8",text:"#ca8a04",border:"#fef08a"},green:{bg:"#f0fdf4",text:"#16a34a",border:"#bbf7d0"},blue:{bg:"#eff6ff",text:"#2563eb",border:"#bfdbfe"} }[color]||{bg:"var(--gray-100)",text:"var(--gray-600)",border:"var(--gray-200)"};
  return <span style={{display:"inline-flex",alignItems:"center",padding:"2px 8px",borderRadius:4,fontSize:11,fontWeight:500,letterSpacing:".02em",background:c.bg,color:c.text,border:`1px solid ${c.border}`,whiteSpace:"nowrap",...s}}>{children}</span>;
}

function SystemBadge({ system }) {
  const colors = { stripe:"#635BFF", zendesk:"#03363D", salesforce:"#00A1E0" };
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"2px 8px",borderRadius:4,fontSize:11,fontWeight:500,background:"var(--gray-50)",border:"1px solid var(--gray-200)",color:"var(--gray-600)"}}>
      <span style={{width:14,height:14,borderRadius:3,background:colors[system]||"var(--gray-400)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:700,color:"#fff"}}>{system[0].toUpperCase()}</span>
      {system}
    </span>
  );
}

function RiskBadge({ level }) { return <Badge color={{critical:"red",high:"orange",medium:"yellow",low:"green"}[level]||"gray"}>{level}</Badge>; }
function SeverityBadge({ severity }) { return <Badge color={{critical:"red",high:"orange",medium:"yellow"}[severity]||"gray"}>{severity}</Badge>; }

function Button({ children, onClick, variant="primary", disabled=false, loading=false, size="md", style:s={} }) {
  const pad = size==="sm"?"6px 12px":size==="lg"?"12px 28px":"9px 20px";
  const base = {display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8,padding:pad,borderRadius:8,fontSize:size==="sm"?12:13,fontWeight:500,fontFamily:"var(--font-body)",cursor:disabled?"not-allowed":"pointer",border:"none",transition:"all .15s ease",opacity:disabled?.5:1,letterSpacing:".01em"};
  const v = {primary:{background:"var(--gray-900)",color:"var(--white)"},secondary:{background:"var(--white)",color:"var(--gray-700)",border:"1px solid var(--gray-200)"},danger:{background:"#dc2626",color:"var(--white)"},ghost:{background:"transparent",color:"var(--gray-500)"}};
  return <button onClick={onClick} disabled={disabled||loading} style={{...base,...v[variant],...s}}>{loading&&<LoadingSpinner size={14}/>}{children}</button>;
}

function LoadingSpinner({ size=16, color="currentColor" }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{animation:"spin .8s linear infinite"}}><circle cx="12" cy="12" r="10" stroke={color} strokeWidth="2.5" opacity=".2"/><path d="M12 2a10 10 0 0110 10" stroke={color} strokeWidth="2.5" strokeLinecap="round"/></svg>;
}

function Card({ children, style:s={}, hover=false, riskTint=null }) {
  const [h,setH]=useState(false);
  return (
    <div onMouseEnter={()=>hover&&setH(true)} onMouseLeave={()=>hover&&setH(false)}
      style={{background:riskTint||"var(--white)",border:"1px solid var(--gray-200)",borderRadius:12,padding:24,transition:"all .15s ease",...(h?{borderColor:"var(--gray-300)",boxShadow:"0 2px 8px rgba(0,0,0,.04)"}:{}),...s}}>
      {children}
    </div>
  );
}

function StatCard({ label, value, color, subtitle }) {
  return (
    <Card style={{flex:1,minWidth:140}}>
      <div style={{fontSize:12,fontWeight:500,color:"var(--gray-400)",textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>{label}</div>
      <div style={{fontSize:28,fontWeight:600,color:color||"var(--gray-900)",letterSpacing:"-.02em"}}>{value}</div>
      {subtitle&&<div style={{fontSize:11,color:"var(--gray-400)",marginTop:4}}>{subtitle}</div>}
    </Card>
  );
}

// ============================================================================
// TOAST
// ============================================================================
function useToast() {
  const [msg,setMsg]=useState(null);
  const show=useCallback(t=>{setMsg(t);setTimeout(()=>setMsg(null),2000)},[]);
  const Toast=msg?<div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:"var(--gray-900)",color:"var(--white)",padding:"8px 20px",borderRadius:8,fontSize:13,fontWeight:500,zIndex:9999,animation:"fade-in .2s ease",pointerEvents:"none"}}>{msg}</div>:null;
  return {show,Toast};
}

// ============================================================================
// COMMAND PALETTE (Cmd+K)
// ============================================================================
function CommandPalette({ open, onClose, agents, onNavigate }) {
  const [query,setQuery]=useState("");
  const inputRef=useRef(null);
  useEffect(()=>{if(open&&inputRef.current){setQuery("");inputRef.current.focus()}},[open]);
  if(!open)return null;
  const commands=[
    {label:"Go to Dashboard",action:()=>{onNavigate("dashboard");onClose()},section:"Navigation"},
    {label:"Go to Integrations",action:()=>{onNavigate("integrations");onClose()},section:"Navigation"},
    ...agents.map(a=>({label:`View ${a.name}`,action:()=>{onNavigate("agent",a.id);onClose()},section:"Agents",sub:`${a.owner} — Score: ${a.blast_radius_score}`})),
  ];
  const filtered=query?commands.filter(c=>c.label.toLowerCase().includes(query.toLowerCase())):commands;
  const sections=[...new Set(filtered.map(c=>c.section))];
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.3)",zIndex:9000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:120}}>
      <div onClick={e=>e.stopPropagation()} style={{width:480,background:"var(--white)",borderRadius:12,border:"1px solid var(--gray-200)",boxShadow:"0 16px 48px rgba(0,0,0,.12)",overflow:"hidden"}}>
        <div style={{padding:"12px 16px",borderBottom:"1px solid var(--gray-100)"}}>
          <input ref={inputRef} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search agents, pages..." style={{width:"100%",border:"none",outline:"none",fontSize:15,fontFamily:"var(--font-body)",color:"var(--gray-900)",background:"transparent"}} onKeyDown={e=>{if(e.key==="Escape")onClose();if(e.key==="Enter"&&filtered.length>0)filtered[0].action()}}/>
        </div>
        <div style={{maxHeight:320,overflowY:"auto",padding:"8px 0"}}>
          {sections.map(sec=>(
            <div key={sec}>
              <div style={{padding:"8px 16px 4px",fontSize:11,fontWeight:500,color:"var(--gray-400)",textTransform:"uppercase",letterSpacing:".06em"}}>{sec}</div>
              {filtered.filter(c=>c.section===sec).map((cmd,i)=>(
                <button key={i} onClick={cmd.action} style={{width:"100%",padding:"8px 16px",textAlign:"left",border:"none",background:"transparent",cursor:"pointer",fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray-700)",display:"flex",justifyContent:"space-between",alignItems:"center"}}
                  onMouseEnter={e=>e.currentTarget.style.background="var(--gray-50)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <span>{cmd.label}</span>
                  {cmd.sub&&<span style={{fontSize:12,color:"var(--gray-400)"}}>{cmd.sub}</span>}
                </button>
              ))}
            </div>
          ))}
          {filtered.length===0&&<div style={{padding:"24px 16px",textAlign:"center",color:"var(--gray-400)",fontSize:13}}>No results</div>}
        </div>
        <div style={{padding:"8px 16px",borderTop:"1px solid var(--gray-100)",display:"flex",gap:12,fontSize:11,color:"var(--gray-400)"}}>
          <span><kbd style={{padding:"1px 5px",borderRadius:3,border:"1px solid var(--gray-200)",background:"var(--gray-50)",fontFamily:"var(--font-mono)",fontSize:10}}>Enter</kbd> select</span>
          <span><kbd style={{padding:"1px 5px",borderRadius:3,border:"1px solid var(--gray-200)",background:"var(--gray-50)",fontFamily:"var(--font-mono)",fontSize:10}}>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SCORE RING
// ============================================================================
function ScoreRing({ score, size=120, strokeWidth=10 }) {
  const [off,setOff]=useState(null);
  const r=(size-strokeWidth)/2, c=2*Math.PI*r, target=c-(score/100)*c, color=getScoreColor(score);
  useEffect(()=>{setOff(c);const t=setTimeout(()=>setOff(target),50);return()=>clearTimeout(t)},[score,c,target]);
  return (
    <svg width={size} height={size} style={{transform:"rotate(-90deg)"}}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--gray-100)" strokeWidth={strokeWidth}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off!==null?off:c} style={{transition:"stroke-dashoffset .8s cubic-bezier(.4,0,.2,1)"}}/>
      <text x={size/2} y={size/2} textAnchor="middle" dominantBaseline="central" style={{transform:"rotate(90deg)",transformOrigin:"center",fontSize:size*.28,fontWeight:600,fontFamily:"var(--font-body)",fill:color}}>{score}</text>
    </svg>
  );
}

// ============================================================================
// NAV
// ============================================================================
function Nav({ currentPage, onNavigate, onOpenPalette }) {
  return (
    <nav style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 32px",height:56,borderBottom:"1px solid var(--gray-200)",background:"var(--white)",position:"sticky",top:0,zIndex:100}}>
      <div onClick={()=>onNavigate("dashboard")} style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="2" width="16" height="16" rx="3" stroke="var(--gray-900)" strokeWidth="1.5"/><path d="M7 6h6M7 10h6M7 14h3" stroke="var(--gray-900)" strokeWidth="1.5" strokeLinecap="round"/><circle cx="15" cy="14" r="2" fill="#ef4444"/></svg>
        <span style={{fontSize:16,fontWeight:600,letterSpacing:"-.02em"}}>ActionGate</span>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:4}}>
        <button onClick={onOpenPalette} style={{padding:"5px 10px",borderRadius:6,fontSize:12,fontFamily:"var(--font-body)",cursor:"pointer",border:"1px solid var(--gray-200)",background:"var(--gray-50)",color:"var(--gray-400)",display:"flex",alignItems:"center",gap:6,marginRight:8}}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2"/><path d="M9.5 9.5L12 12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
          <span style={{fontFamily:"var(--font-mono)",fontSize:10,opacity:.7}}>⌘K</span>
        </button>
        {[{key:"dashboard",label:"Dashboard"},{key:"integrations",label:"Integrations"}].map(item=>(
          <button key={item.key} onClick={()=>onNavigate(item.key)} style={{padding:"6px 14px",borderRadius:6,fontSize:13,fontWeight:500,fontFamily:"var(--font-body)",cursor:"pointer",border:"none",background:currentPage===item.key?"var(--gray-100)":"transparent",color:currentPage===item.key?"var(--gray-900)":"var(--gray-500)",transition:"all .15s ease"}}>{item.label}</button>
        ))}
      </div>
    </nav>
  );
}

// ============================================================================
// ONBOARDING CHECKLIST
// ============================================================================
function OnboardingChecklist({ completedSteps, onAction }) {
  const steps=[
    {key:"connect",label:"Connect your first system",desc:"Link Stripe, Zendesk, or another tool so we can read agent permissions",action:"Go to Integrations",done:completedSteps.includes("connect")},
    {key:"scan",label:"Scan your agents",desc:"We'll discover every agent and map what it can do",action:"Run scan",done:completedSteps.includes("scan")},
    {key:"simulate",label:"Run your first simulation",desc:"Test worst-case scenarios in a safe sandbox",action:"Pick an agent",done:completedSteps.includes("simulate")},
  ];
  const doneCount=steps.filter(s=>s.done).length;
  return (
    <Card style={{marginBottom:28,padding:0,overflow:"hidden",border:doneCount===3?"1px solid var(--green-500)":"1px solid var(--blue-500)"}}>
      <div style={{padding:"16px 24px",background:doneCount===3?"rgba(34,197,94,.04)":"rgba(59,130,246,.04)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:14,fontWeight:600,marginBottom:2}}>{doneCount===3?"Setup complete":"Get started with ActionGate"}</div>
          <div style={{fontSize:12,color:"var(--gray-500)"}}>{doneCount===3?"You're all set.":doneCount+" of "+steps.length+" steps complete"}</div>
        </div>
        <div style={{width:80,height:6,background:"var(--gray-100)",borderRadius:3,overflow:"hidden"}}>
          <div style={{width:(doneCount/steps.length*100)+"%",height:"100%",background:doneCount===3?"var(--green-500)":"var(--blue-500)",borderRadius:3,transition:"width .4s ease"}}/>
        </div>
      </div>
      <div style={{padding:"4px 24px 16px"}}>
        {steps.map((step,i)=>(
          <div key={step.key} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 0",borderBottom:i<steps.length-1?"1px solid var(--gray-100)":"none"}}>
            <div style={{width:22,height:22,borderRadius:"50%",border:step.done?"none":"2px solid var(--gray-200)",background:step.done?"var(--green-500)":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              {step.done&&<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6L5 8.5L9.5 4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:500,color:step.done?"var(--gray-400)":"var(--gray-900)",textDecoration:step.done?"line-through":"none"}}>{step.label}</div>
              {!step.done&&<div style={{fontSize:12,color:"var(--gray-400)",marginTop:1}}>{step.desc}</div>}
            </div>
            {!step.done&&<Button size="sm" variant="secondary" onClick={()=>onAction(step.key)}>{step.action}</Button>}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ============================================================================
// ATTACK PATH GRAPH — visual permission chain SVG
// ============================================================================
function AttackPathGraph({ actions, chains }) {
  if(!actions||actions.length===0)return null;
  const svgW=560, cx=svgW/2, cy=170;
  const domainColors={Financial:"#ef4444",Data:"#f97316",Operations:"#3b82f6"};
  const nodes=actions.map((a,i)=>{
    const angle=(i/actions.length)*2*Math.PI-Math.PI/2;
    return{...a,x:cx+190*Math.cos(angle),y:cy+110*Math.sin(angle),color:domainColors[a.domain]||"#6b7280"};
  });
  const financialNodes=nodes.filter(n=>n.domain==="Financial");
  const dataNodes=nodes.filter(n=>n.domain==="Data");
  const dangerPairs=[];
  if(chains.some(c=>c.severity==="critical")){
    for(const d of dataNodes)for(const f of financialNodes)dangerPairs.push({from:d,to:f});
  }

  return (
    <div style={{marginBottom:24}}>
      <div style={{fontSize:11,fontWeight:500,color:"var(--gray-400)",textTransform:"uppercase",letterSpacing:".06em",marginBottom:12}}>Permission attack paths</div>
      <Card style={{padding:16,overflow:"hidden"}}>
        <svg width="100%" viewBox={`0 0 ${svgW} 340`} style={{display:"block"}}>
          <defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></marker></defs>
          {dangerPairs.map((p,i)=><line key={i} x1={p.from.x} y1={p.from.y} x2={p.to.x} y2={p.to.y} stroke="#ef4444" strokeWidth="2" strokeDasharray="6 4" opacity=".35" markerEnd="url(#ah)"/>)}
          {nodes.map((n,i)=>{
            const isCrit=n.risk_level==="critical";
            return(
              <g key={i}>
                {isCrit&&<circle cx={n.x} cy={n.y} r={38} fill="none" stroke="#ef4444" strokeWidth="1" opacity=".3" strokeDasharray="4 3"/>}
                <circle cx={n.x} cy={n.y} r={32} fill={n.color+"12"} stroke={n.color} strokeWidth={isCrit?2:1}/>
                {!n.reversible&&<circle cx={n.x+24} cy={n.y-24} r={6} fill="#ef4444" stroke="white" strokeWidth="1.5"/>}
                <text x={n.x} y={n.y-3} textAnchor="middle" dominantBaseline="central" style={{fontSize:10,fontWeight:600,fill:n.color,fontFamily:"var(--font-body)"}}>{n.domain.slice(0,3).toUpperCase()}</text>
                <text x={n.x} y={n.y+11} textAnchor="middle" style={{fontSize:8,fill:"var(--gray-500)",fontFamily:"var(--font-body)"}}>{n.action.length>18?n.action.slice(0,16)+"..":n.action}</text>
              </g>
            );
          })}
          {Object.entries(domainColors).map(([d,c],i)=>(
            <g key={d} transform={`translate(${16+i*120},320)`}><circle cx="5" cy="5" r="5" fill={c+"30"} stroke={c} strokeWidth="1"/><text x="16" y="9" style={{fontSize:10,fill:"var(--gray-500)",fontFamily:"var(--font-body)"}}>{d}</text></g>
          ))}
          <g transform={`translate(${16+3*120},320)`}><line x1="0" y1="5" x2="20" y2="5" stroke="#ef4444" strokeWidth="2" strokeDasharray="4 3" opacity=".5"/><text x="26" y="9" style={{fontSize:10,fill:"var(--gray-500)",fontFamily:"var(--font-body)"}}>Dangerous path</text></g>
        </svg>
      </Card>
    </div>
  );
}

// ============================================================================
// AGENT CARD — risk-tinted background
// ============================================================================
function AgentCard({ agent, onViewReport }) {
  const color=getScoreColor(agent.blast_radius_score);
  const tint=getScoreTint(agent.blast_radius_score);
  const isCritical=agent.blast_radius_score>=70;
  return (
    <Card hover riskTint={tint} style={{animation:"fade-in .3s ease forwards",...(isCritical?{borderColor:"rgba(239,68,68,.2)"}:{})}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <div style={{flex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
            <span style={{fontSize:15,fontWeight:500}}>{agent.name}</span>
            {isCritical&&<Badge color="red" style={{animation:"glow-pulse 3s ease-in-out infinite"}}>critical risk</Badge>}
          </div>
          <div style={{fontSize:13,color:"var(--gray-400)",marginBottom:10}}>{agent.owner} — {agent.purpose}</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{agent.connected_systems.map(s=><SystemBadge key={s} system={s}/>)}</div>
        </div>
        <Button variant="secondary" onClick={()=>onViewReport(agent.id)} size="sm">View report →</Button>
      </div>
      <div style={{marginTop:16}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
          <span style={{fontSize:11,color:"var(--gray-400)",fontWeight:500,textTransform:"uppercase",letterSpacing:".05em"}}>Blast radius</span>
          <span style={{fontSize:14,fontWeight:600,color,fontVariantNumeric:"tabular-nums"}}>{agent.blast_radius_score}/100</span>
        </div>
        <div style={{height:6,background:"var(--gray-100)",borderRadius:3,overflow:"hidden"}}>
          <div style={{width:agent.blast_radius_score+"%",height:"100%",background:color,borderRadius:3,transition:"width .6s cubic-bezier(.4,0,.2,1)"}}/>
        </div>
      </div>
      <div style={{marginTop:10,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <span style={{fontSize:12,color:agent.findings_count>0?"var(--red-600)":"var(--gray-400)",fontWeight:agent.findings_count>0?500:400}}>
          {agent.findings_count>0&&<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{verticalAlign:"-1px",marginRight:4}}><circle cx="6" cy="6" r="5" stroke="#dc2626" strokeWidth="1.2"/><path d="M6 3.5v3M6 8v.5" stroke="#dc2626" strokeWidth="1.2" strokeLinecap="round"/></svg>}
          {agent.findings_count} finding{agent.findings_count!==1?"s":""}
        </span>
        {agent.last_scanned&&<span style={{fontSize:11,color:"var(--gray-400)"}}>Scanned {new Date(agent.last_scanned).toLocaleDateString()}</span>}
      </div>
    </Card>
  );
}

// ============================================================================
// DASHBOARD — "needs attention" section + onboarding
// ============================================================================
function DashboardPage({ agents, findings, onNavigate }) {
  const sorted=[...agents].sort((a,b)=>b.blast_radius_score-a.blast_radius_score);
  const criticalAgents=sorted.filter(a=>a.blast_radius_score>=70);
  const otherAgents=sorted.filter(a=>a.blast_radius_score<70);
  const totalFindings=agents.reduce((s,a)=>s+a.findings_count,0);
  const maxExposure=findings.reduce((s,f)=>s+f.business_impact.financial.reduce((a,b)=>a+(b.amount||0),0),0);
  const completedSteps=["connect","scan"];

  return (
    <div style={{maxWidth:900,margin:"0 auto",padding:"32px 24px"}}>
      <div style={{marginBottom:28}}>
        <h1 style={{fontSize:22,fontWeight:600,letterSpacing:"-.02em",marginBottom:4}}>Agent Overview</h1>
        <p style={{fontSize:13,color:"var(--gray-400)"}}>Monitor blast radius and risk across all deployed agents</p>
      </div>

      <OnboardingChecklist completedSteps={completedSteps} onAction={step=>{
        if(step==="connect")onNavigate("integrations");
        if(step==="simulate"){const a=criticalAgents[0]||sorted[0];if(a)onNavigate("agent",a.id);}
      }}/>

      <div style={{display:"flex",gap:12,marginBottom:28,flexWrap:"wrap"}}>
        <StatCard label="Total agents" value={agents.length} subtitle="Across 3 systems"/>
        <StatCard label="Critical risk" value={criticalAgents.length} color="var(--red-500)" subtitle={criticalAgents.length>0?"Needs immediate review":"All clear"}/>
        <StatCard label="Total findings" value={totalFindings} color={totalFindings>0?"var(--red-500)":undefined} subtitle={"$"+(maxExposure/100).toLocaleString()+" max exposure"}/>
        <StatCard label="Simulations" value={12} subtitle="Last 30 days"/>
      </div>

      {criticalAgents.length>0&&(
        <div style={{marginBottom:28}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1l7 14H1L8 1z" stroke="#dc2626" strokeWidth="1.5" strokeLinejoin="round"/><path d="M8 6v3.5M8 11.5v.5" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <span style={{fontSize:13,fontWeight:600,color:"var(--red-600)"}}>Needs attention</span>
            <span style={{fontSize:12,color:"var(--gray-400)"}}>— {criticalAgents.length} agent{criticalAgents.length>1?"s":""} with critical blast radius</span>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {criticalAgents.map(a=><AgentCard key={a.id} agent={a} onViewReport={id=>onNavigate("agent",id)}/>)}
          </div>
        </div>
      )}

      {otherAgents.length>0&&(
        <div>
          <div style={{fontSize:13,fontWeight:500,color:"var(--gray-500)",marginBottom:12}}>All agents</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {otherAgents.map(a=><AgentCard key={a.id} agent={a} onViewReport={id=>onNavigate("agent",id)}/>)}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// INTEGRATIONS PAGE
// ============================================================================
function IntegrationCard({ integration, onConnect }) {
  const [connecting,setConnecting]=useState(false);
  const [connected,setConnected]=useState(integration.status==="connected");
  const [fields,setFields]=useState({});
  const isSF=integration.system==="salesforce";
  const brandColors={stripe:"#635BFF",zendesk:"#03363D",salesforce:"#00A1E0"};
  const handleConnect=async()=>{
    setConnecting(true);
    try{await api.integrations.connect(integration.system,fields)}catch(e){}
    await new Promise(r=>setTimeout(r,1500));
    setConnecting(false);setConnected(true);
    if(onConnect)onConnect(integration.system);
  };
  const inp={width:"100%",padding:"8px 12px",borderRadius:6,border:"1px solid var(--gray-200)",fontSize:13,fontFamily:"var(--font-body)",outline:"none",background:"var(--white)"};
  return (
    <Card style={{opacity:isSF?.5:1}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:36,height:36,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",background:(brandColors[integration.system]||"#666")+"15",color:brandColors[integration.system],fontSize:14,fontWeight:700,fontFamily:"var(--font-mono)"}}>{integration.system[0].toUpperCase()}</div>
          <div>
            <div style={{fontSize:15,fontWeight:500,textTransform:"capitalize"}}>{integration.system}</div>
            {isSF&&<div style={{fontSize:12,color:"var(--gray-400)"}}>Coming soon</div>}
          </div>
        </div>
        {connected&&<Badge color="green">Connected</Badge>}
      </div>
      {connected?(
        <div>
          <div style={{padding:"8px 12px",background:"var(--gray-50)",borderRadius:6,fontFamily:"var(--font-mono)",fontSize:12,color:"var(--gray-500)",marginBottom:12}}>sk_test_••••••••••••••••</div>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            {Object.entries(integration.metadata).map(([k,v])=>(<div key={k} style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"var(--gray-500)"}}><span>{k}</span><span style={{fontWeight:500,color:"var(--gray-700)"}}>{v}</span></div>))}
          </div>
        </div>
      ):!isSF?(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {integration.system==="stripe"&&<input style={inp} placeholder="sk_test_..." onChange={e=>setFields({...fields,api_key:e.target.value})}/>}
          {integration.system==="zendesk"&&<><input style={inp} placeholder="Subdomain" onChange={e=>setFields({...fields,subdomain:e.target.value})}/><input style={inp} placeholder="Email" onChange={e=>setFields({...fields,email:e.target.value})}/><input style={inp} placeholder="API token" onChange={e=>setFields({...fields,api_token:e.target.value})}/></>}
          <Button onClick={handleConnect} loading={connecting} style={{alignSelf:"flex-start",marginTop:4}}>Connect</Button>
        </div>
      ):null}
    </Card>
  );
}

function IntegrationsPage({ integrations, onNavigate }) {
  const [analyzing,setAnalyzing]=useState(false);
  const connCount=integrations.filter(i=>i.status==="connected").length;
  return (
    <div style={{maxWidth:720,margin:"0 auto",padding:"32px 24px"}}>
      <div style={{marginBottom:8}}>
        <h1 style={{fontSize:22,fontWeight:600,letterSpacing:"-.02em",marginBottom:4}}>Connected Systems</h1>
        <p style={{fontSize:13,color:"var(--gray-400)"}}>Connect your tools to begin mapping agent authority</p>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:24}}>
        <div style={{flex:1,height:4,background:"var(--gray-100)",borderRadius:2,overflow:"hidden"}}><div style={{width:(connCount/integrations.length*100)+"%",height:"100%",background:"var(--green-500)",borderRadius:2,transition:"width .4s ease"}}/></div>
        <span style={{fontSize:12,color:"var(--gray-400)"}}>{connCount}/{integrations.length} connected</span>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:16,marginBottom:32}}>
        {integrations.map(i=><IntegrationCard key={i.system} integration={i}/>)}
      </div>
      <div style={{textAlign:"center"}}>
        <Button onClick={async()=>{setAnalyzing(true);await new Promise(r=>setTimeout(r,2000));onNavigate("dashboard")}} loading={analyzing}>Analyze agents →</Button>
      </div>
    </div>
  );
}

// ============================================================================
// BUSINESS ACTION + CHAIN CARDS (kept good)
// ============================================================================
function BusinessActionCard({ action }) {
  return (
    <Card style={{padding:16,animation:"fade-in .3s ease forwards"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}><Badge>{action.domain}</Badge><span style={{fontSize:14,fontWeight:500}}>{action.action}</span></div>
        <RiskBadge level={action.risk_level}/>
      </div>
      <div style={{fontSize:13,color:"var(--gray-500)",marginBottom:10,lineHeight:1.5}}>{action.description}</div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{fontSize:12,display:"flex",alignItems:"center",gap:4}}>
          {action.reversible?<span style={{color:"var(--gray-400)"}}>↩ Reversible</span>:(
            <span style={{color:"var(--red-600)",fontWeight:500}}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{verticalAlign:"-1px",marginRight:3}}><path d="M6 1l5 10H1L6 1z" stroke="#dc2626" strokeWidth="1.2" strokeLinejoin="round"/><path d="M6 5v2.5M6 9v.5" stroke="#dc2626" strokeWidth="1.2" strokeLinecap="round"/></svg>
              Irreversible
            </span>
          )}
        </div>
        <code style={{fontSize:10,color:"var(--gray-400)",fontFamily:"var(--font-mono)"}}>{action.permission_key}</code>
      </div>
    </Card>
  );
}

function DangerousChainCard({ chain }) {
  const bc=chain.severity==="critical"?"var(--red-500)":"var(--orange-500)";
  return (
    <div style={{padding:16,background:"var(--white)",border:"1px solid var(--gray-200)",borderRadius:12,borderLeft:"3px solid "+bc,animation:"fade-in .3s ease forwards"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
        <span style={{fontSize:14,fontWeight:500,lineHeight:1.4,flex:1,marginRight:12}}>{chain.description}</span>
        <SeverityBadge severity={chain.severity}/>
      </div>
      <div style={{fontSize:13,color:"var(--gray-500)",lineHeight:1.5}}>{chain.risk}</div>
    </div>
  );
}

// ============================================================================
// FINDING CARD — actionable with copy/share
// ============================================================================
function FindingCard({ finding, onCopy }) {
  const bc=finding.severity==="critical"?"var(--red-500)":"var(--orange-500)";
  const exp=finding.business_impact.financial.reduce((s,f)=>s+(f.amount||0),0);
  return (
    <div style={{padding:20,background:"var(--white)",border:"1px solid var(--gray-200)",borderRadius:12,borderLeft:"3px solid "+bc,animation:"slide-up .4s ease forwards"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
        <div><span style={{fontSize:14,fontWeight:500}}>{finding.scenario}</span>{exp>0&&<span style={{fontSize:12,color:"var(--red-600)",fontWeight:500,marginLeft:8}}>${(exp/100).toLocaleString()} exposure</span>}</div>
        <SeverityBadge severity={finding.severity}/>
      </div>
      <div style={{fontSize:13,color:"var(--gray-500)",lineHeight:1.5,marginBottom:16}}>{finding.outcome}</div>
      <div style={{marginBottom:12}}>
        <div style={{fontSize:11,fontWeight:500,color:"var(--gray-400)",textTransform:"uppercase",letterSpacing:".06em",marginBottom:8}}>Tool call sequence</div>
        <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
          {finding.business_impact.tools_called.map((t,i)=>(
            <span key={i} style={{display:"inline-flex",alignItems:"center",gap:4}}>
              <code style={{padding:"3px 8px",borderRadius:4,background:"var(--gray-50)",border:"1px solid var(--gray-200)",fontSize:11,fontFamily:"var(--font-mono)",color:"var(--gray-700)"}}>{t}</code>
              {i<finding.business_impact.tools_called.length-1&&<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 6h4M6.5 4l2 2-2 2" stroke="var(--gray-300)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </span>
          ))}
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",paddingTop:12,borderTop:"1px solid var(--gray-100)"}}>
        <span style={{fontSize:12,color:"var(--red-600)",fontWeight:500}}>Approval requested: No</span>
        <div style={{display:"flex",gap:6}}>
          <Button size="sm" variant="ghost" onClick={()=>onCopy&&onCopy(finding.recommendation)}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="3.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M8.5 3.5V2a1 1 0 00-1-1H2a1 1 0 00-1 1v5.5a1 1 0 001 1h1.5" stroke="currentColor" strokeWidth="1.2"/></svg>
            Copy fix
          </Button>
          <Button size="sm" variant="secondary" onClick={()=>onCopy&&onCopy("[ActionGate] "+finding.scenario+": "+finding.recommendation)}>Share →</Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// RECOMMENDATION CARD — with copy button
// ============================================================================
function RecommendationCard({ finding, currentScore, onCopy }) {
  const red=finding.severity==="critical"?15:10;
  const reduced=Math.max(0,currentScore-red);
  return (
    <Card style={{padding:20,animation:"fade-in .3s ease forwards"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
        <div style={{fontSize:11,fontWeight:500,color:"var(--gray-400)",textTransform:"uppercase",letterSpacing:".06em"}}>{finding.scenario}</div>
        <SeverityBadge severity={finding.severity}/>
      </div>
      <div style={{fontSize:14,lineHeight:1.6,color:"var(--gray-700)",marginBottom:16}}>{finding.recommendation}</div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13}}>
          <span style={{fontSize:11,fontWeight:500,color:"var(--gray-400)",textTransform:"uppercase",letterSpacing:".06em"}}>Risk reduction</span>
          <span style={{fontWeight:600,color:getScoreColor(currentScore),fontVariantNumeric:"tabular-nums"}}>{currentScore}</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8M8.5 4.5L11 7l-2.5 2.5" stroke="var(--gray-300)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span style={{fontWeight:600,color:getScoreColor(reduced),fontVariantNumeric:"tabular-nums"}}>{reduced}</span>
        </div>
        <Button size="sm" variant="secondary" onClick={()=>onCopy&&onCopy(finding.recommendation)}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="3.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M8.5 3.5V2a1 1 0 00-1-1H2a1 1 0 00-1 1v5.5a1 1 0 001 1h1.5" stroke="currentColor" strokeWidth="1.2"/></svg>
          Copy
        </Button>
      </div>
    </Card>
  );
}

// ============================================================================
// SIMULATION TAB — improved empty state + scenario checklist
// ============================================================================
function SimulationTab({ agentId, findings, onCopy }) {
  const [simState,setSimState]=useState("idle");
  const [progress,setProgress]=useState({current:"",done:0,total:5});
  const scenarios=["Duplicate refund request","Enterprise customer high-value refund","Cancellation and refund combination","Expired payment method retry","Cross-system data exfiltration"];
  const runSim=async()=>{
    setSimState("running");
    // TODO: replace with real polling when backend is ready
    // const task = await api.simulation.trigger(agentId)
    // const poll = setInterval(async () => { const status = await api.simulation.status(task.task_id); setProgress({current:status.current_scenario||'',done:status.scenarios_complete,total:status.scenarios_total}); if(status.status==='complete'||status.status==='failed'){clearInterval(poll);const f=await api.agents.getFindings(agentId);setFindings(f);setSimState('complete')} }, 2000)
    for(let i=0;i<scenarios.length;i++){setProgress({current:scenarios[i],done:i,total:scenarios.length});await new Promise(r=>setTimeout(r,800));}
    setProgress({current:"",done:scenarios.length,total:scenarios.length});setSimState("complete");
  };

  if(simState==="idle")return(
    <div style={{textAlign:"center",padding:"48px 24px"}}>
      <div style={{width:56,height:56,borderRadius:16,background:"var(--gray-50)",border:"1px solid var(--gray-200)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M8 5v14l11-7L8 5z" fill="var(--gray-300)"/></svg>
      </div>
      <div style={{fontSize:15,fontWeight:500,marginBottom:6}}>Test worst-case scenarios</div>
      <div style={{fontSize:13,color:"var(--gray-400)",marginBottom:24,maxWidth:360,margin:"0 auto 24px",lineHeight:1.5}}>ActionGate will simulate misuse scenarios in a sandboxed environment and report what damage is possible.</div>
      <Button onClick={runSim}><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 2.5v9l8-4.5L4 2.5z" fill="currentColor"/></svg>Run simulation</Button>
      <div style={{fontSize:11,color:"var(--gray-400)",marginTop:12}}>Takes ~30 seconds. No production data is affected.</div>
    </div>
  );

  if(simState==="running"){
    const pct=(progress.done/progress.total)*100;
    return(
      <div style={{padding:"40px 24px",maxWidth:500,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:24}}><LoadingSpinner size={24} color="var(--gray-400)"/></div>
        <div style={{fontSize:13,color:"var(--gray-500)",textAlign:"center",marginBottom:16}}>Testing: <strong style={{color:"var(--gray-700)"}}>{progress.current}</strong> ({progress.done}/{progress.total})</div>
        <div style={{height:4,background:"var(--gray-100)",borderRadius:2,overflow:"hidden"}}><div style={{width:pct+"%",height:"100%",background:"var(--gray-900)",borderRadius:2,transition:"width .4s ease",backgroundImage:"linear-gradient(45deg,rgba(255,255,255,.15) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.15) 50%,rgba(255,255,255,.15) 75%,transparent 75%)",backgroundSize:"40px 40px",animation:"progress-stripe 1s linear infinite"}}/></div>
        <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:20}}>
          {scenarios.map((s,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:i<progress.done?"var(--green-600)":i===progress.done?"var(--gray-700)":"var(--gray-300)"}}>
              {i<progress.done?<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" fill="#22c55e"/><path d="M3.5 6L5.5 8L8.5 4.5" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>:i===progress.done?<LoadingSpinner size={12} color="var(--gray-400)"/>:<div style={{width:12,height:12,borderRadius:"50%",border:"1.5px solid var(--gray-200)"}}/>}
              {s}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const agentFindings=findings.filter(f=>f.agent_id===agentId);
  return(
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}><Badge color="green">Complete</Badge><span style={{fontSize:13,color:"var(--gray-500)"}}>{agentFindings.length} findings detected</span></div>
        <Button size="sm" variant="secondary" onClick={runSim}>Re-run</Button>
      </div>
      {agentFindings.map(f=><FindingCard key={f.id} finding={f} onCopy={onCopy}/>)}
    </div>
  );
}

// ============================================================================
// AGENT DETAIL PAGE — with attack path graph + improved empty states
// ============================================================================
function AgentDetailPage({ agent, findings, onBack, onCopy }) {
  const [activeTab,setActiveTab]=useState("authority");
  const agentFindings=findings.filter(f=>f.agent_id===agent.id);
  const tabs=[{key:"authority",label:"Authority",count:agent.business_actions.length},{key:"simulation",label:"Simulation",count:null},{key:"recommendations",label:"Recommendations",count:agentFindings.length}];

  return(
    <div style={{maxWidth:900,margin:"0 auto",padding:"32px 24px"}}>
      <button onClick={onBack} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,color:"var(--gray-400)",background:"none",border:"none",cursor:"pointer",marginBottom:20,fontFamily:"var(--font-body)",padding:0}}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 3L5 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>All agents
      </button>

      <div style={{marginBottom:24}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
          <h1 style={{fontSize:22,fontWeight:600,letterSpacing:"-.02em"}}>{agent.name}</h1>
          {agent.blast_radius_score>=70&&<Badge color="red">critical risk</Badge>}
        </div>
        <div style={{fontSize:13,color:"var(--gray-400)",marginBottom:8}}>{agent.purpose}</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{agent.connected_systems.map(s=><SystemBadge key={s} system={s}/>)}</div>
      </div>

      <div style={{display:"flex",gap:16,marginBottom:32,alignItems:"stretch",flexWrap:"wrap"}}>
        <Card style={{display:"flex",alignItems:"center",justifyContent:"center",padding:20,minWidth:140}}><ScoreRing score={agent.blast_radius_score} size={110} strokeWidth={9}/></Card>
        <StatCard label="Business actions" value={agent.business_actions.length} subtitle={agent.business_actions.filter(a=>!a.reversible).length+" irreversible"}/>
        <StatCard label="Findings" value={agent.findings_count} color={agent.findings_count>0?"var(--red-500)":undefined} subtitle={agent.findings_count>0?"From last simulation":"None yet"}/>
      </div>

      <div style={{display:"flex",gap:2,marginBottom:28,borderBottom:"1px solid var(--gray-100)"}}>
        {tabs.map(tab=>(
          <button key={tab.key} onClick={()=>setActiveTab(tab.key)} style={{padding:"10px 18px",fontSize:13,fontWeight:500,fontFamily:"var(--font-body)",cursor:"pointer",border:"none",background:"transparent",color:activeTab===tab.key?"var(--gray-900)":"var(--gray-400)",borderBottom:activeTab===tab.key?"2px solid var(--gray-900)":"2px solid transparent",transition:"all .15s ease",marginBottom:-1,display:"flex",alignItems:"center",gap:6}}>
            {tab.label}
            {tab.count!==null&&tab.count>0&&<span style={{fontSize:10,fontWeight:600,padding:"1px 6px",borderRadius:10,background:activeTab===tab.key?"var(--gray-900)":"var(--gray-200)",color:activeTab===tab.key?"var(--white)":"var(--gray-500)"}}>{tab.count}</span>}
          </button>
        ))}
      </div>

      {activeTab==="authority"&&(
        <div>
          {agent.business_actions.length>0?(
            <>
              <AttackPathGraph actions={agent.business_actions} chains={agent.dangerous_chains}/>
              <div style={{fontSize:11,fontWeight:500,color:"var(--gray-400)",textTransform:"uppercase",letterSpacing:".06em",marginBottom:12}}>What this agent can do</div>
              <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:32}}>{agent.business_actions.map(a=><BusinessActionCard key={a.permission_key} action={a}/>)}</div>
              {agent.dangerous_chains.length>0&&(
                <>
                  <div style={{fontSize:11,fontWeight:500,color:"var(--gray-400)",textTransform:"uppercase",letterSpacing:".06em",marginBottom:12}}>Dangerous combinations</div>
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>{agent.dangerous_chains.map((c,i)=><DangerousChainCard key={i} chain={c}/>)}</div>
                </>
              )}
            </>
          ):(
            <div style={{textAlign:"center",padding:"48px 24px"}}>
              <div style={{width:56,height:56,borderRadius:16,background:"var(--gray-50)",border:"1px solid var(--gray-200)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2L4 7v10l8 5 8-5V7l-8-5z" stroke="var(--gray-300)" strokeWidth="1.5" strokeLinejoin="round"/><path d="M12 12v10M12 12L4 7M12 12l8-5" stroke="var(--gray-300)" strokeWidth="1.5"/></svg>
              </div>
              <div style={{fontSize:15,fontWeight:500,marginBottom:4}}>No authority data yet</div>
              <div style={{fontSize:13,color:"var(--gray-400)",maxWidth:300,margin:"0 auto"}}>Run a scan on this agent's connected systems to map its business actions and permissions.</div>
            </div>
          )}
        </div>
      )}

      {activeTab==="simulation"&&<SimulationTab agentId={agent.id} findings={findings} onCopy={onCopy}/>}

      {activeTab==="recommendations"&&(
        <div>
          {agentFindings.length>0?(
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {agentFindings.map(f=><RecommendationCard key={f.id} finding={f} currentScore={agent.blast_radius_score} onCopy={onCopy}/>)}
              <Card style={{background:"var(--gray-50)",border:"1px dashed var(--gray-200)",textAlign:"center",padding:20}}>
                <div style={{fontSize:13,color:"var(--gray-500)",marginBottom:8}}>Estimated risk after applying all recommendations</div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12}}>
                  <span style={{fontSize:28,fontWeight:600,color:getScoreColor(agent.blast_radius_score)}}>{agent.blast_radius_score}</span>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M14 7l5 5-5 5" stroke="var(--gray-300)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  <span style={{fontSize:28,fontWeight:600,color:getScoreColor(Math.max(0,agent.blast_radius_score-agentFindings.reduce((s,f)=>s+(f.severity==="critical"?15:10),0)))}}>{Math.max(0,agent.blast_radius_score-agentFindings.reduce((s,f)=>s+(f.severity==="critical"?15:10),0))}</span>
                </div>
              </Card>
            </div>
          ):(
            <div style={{textAlign:"center",padding:"48px 24px"}}>
              <div style={{width:56,height:56,borderRadius:16,background:"var(--gray-50)",border:"1px solid var(--gray-200)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4" stroke="var(--gray-300)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="12" cy="12" r="9" stroke="var(--gray-300)" strokeWidth="1.5"/></svg>
              </div>
              <div style={{fontSize:15,fontWeight:500,marginBottom:4}}>No recommendations yet</div>
              <div style={{fontSize:13,color:"var(--gray-400)",maxWidth:300,margin:"0 auto",marginBottom:16}}>Run a simulation first to generate findings and actionable recommendations.</div>
              <Button variant="secondary" onClick={()=>setActiveTab("simulation")}>Go to Simulation →</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// APP ROOT
// ============================================================================
export default function ActionGate() {
  const [currentPage,setCurrentPage]=useState("dashboard");
  const [selectedAgentId,setSelectedAgentId]=useState(null);
  const [paletteOpen,setPaletteOpen]=useState(false);
  const {show:showToast,Toast}=useToast();
  const agents=PLACEHOLDER_AGENTS, findings=PLACEHOLDER_FINDINGS, integrations=PLACEHOLDER_INTEGRATIONS;

  const navigate=useCallback((page,agentId)=>{
    if(page==="agent"&&agentId){setSelectedAgentId(agentId);setCurrentPage("agent")}
    else{setCurrentPage(page);setSelectedAgentId(null)}
  },[]);

  const handleCopy=useCallback(text=>{
    navigator.clipboard.writeText(text).then(()=>showToast("Copied to clipboard")).catch(()=>showToast("Failed to copy"));
  },[showToast]);

  useEffect(()=>{
    const handler=e=>{
      if((e.metaKey||e.ctrlKey)&&e.key==="k"){e.preventDefault();setPaletteOpen(p=>!p)}
      if(e.key==="Escape")setPaletteOpen(false);
    };
    document.addEventListener("keydown",handler);
    return()=>document.removeEventListener("keydown",handler);
  },[]);

  const selectedAgent=agents.find(a=>a.id===selectedAgentId);

  return(
    <div style={{minHeight:"100vh",background:"var(--gray-50)"}}>
      <style>{globalStyles}</style>
      <Nav currentPage={currentPage==="agent"?"dashboard":currentPage} onNavigate={navigate} onOpenPalette={()=>setPaletteOpen(true)}/>
      <CommandPalette open={paletteOpen} onClose={()=>setPaletteOpen(false)} agents={agents} onNavigate={navigate}/>
      {Toast}
      {currentPage==="dashboard"&&<DashboardPage agents={agents} findings={findings} onNavigate={navigate}/>}
      {currentPage==="integrations"&&<IntegrationsPage integrations={integrations} onNavigate={navigate}/>}
      {currentPage==="agent"&&selectedAgent&&<AgentDetailPage agent={selectedAgent} findings={findings} onBack={()=>navigate("dashboard")} onCopy={handleCopy}/>}
    </div>
  );
}
