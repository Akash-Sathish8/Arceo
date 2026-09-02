"use client";

import { useEffect, useState } from "react";
import { useArmed } from "@/lib/useArmed";

/* The check on the pull request.
 *
 * Deliberately not the hero. Arceo is a runtime product — what an agent costs
 * and what it can reach — and opening on a CI check would tell a CIO they are
 * buying a linter. But the GitHub Action is how the person who has to adopt
 * Arceo first meets it, so it earns a section near the close: everything above
 * has already said what the product knows, and this says where it shows up.
 *
 * Rendered in Arceo's own dark palette rather than as a copy of anyone's UI —
 * the structure of a checks list is enough to place the reader. Every string
 * matches the real action: the check name from .github/actions/scan/action.yml,
 * the default threshold of 60, and the summary line the run posts back
 * (files scanned · agents found · max blast radius · critical chains ·
 * threshold). Two agents clear it. The third does not. */

type Agent = {
  file: string;
  name: string;
  score: number;
  chain?: string;
};

const AGENTS: Agent[] = [
  { file: "agents/support.py", name: "support-bot", score: 34 },
  { file: "agents/billing.py", name: "invoice-bot", score: 41 },
  {
    file: "agents/ops.py",
    name: "deploy-bot",
    score: 82,
    chain: "changes production, then deletes records",
  },
];

const THRESHOLD = 60;

/* One beat per agent resolving, then the verdict. */
const BEATS = [1100, 850, 850, 900, 3400];
const FINAL = BEATS.length - 1;

function Spinner() {
  return (
    <span className="pr-spin" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
        <path
          d="M7 1.5A5.5 5.5 0 0 1 12.5 7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

function Mark({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? "pr-mark pass" : "pr-mark fail"} aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
        {ok ? (
          <path
            d="M2.5 6.2l2.4 2.4L9.5 4"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        )}
      </svg>
    </span>
  );
}

export default function PullRequest() {
  const [ref, armed] = useArmed<HTMLElement>(0.2);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!armed) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setStep(FINAL);
      return;
    }
    const id = setTimeout(() => setStep((s) => (s + 1) % BEATS.length), BEATS[step]);
    return () => clearTimeout(id);
  }, [armed, step]);

  /* Agent i has resolved once the run has reached beat i + 1. */
  const resolved = (i: number) => step >= i + 1;
  const done = step >= FINAL;

  return (
    <section
      ref={ref}
      style={{
        padding: "104px 0 112px",
        background: "var(--ground)",
        borderTop: "1px solid var(--rule)",
      }}
    >
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 32px" }}>
        <div className="pr-grid">
          <div>
            <span className="eyebrow">On every pull request</span>
            <h2
              style={{
                fontSize: "clamp(28px, 3.3vw, 42px)",
                fontWeight: 600,
                letterSpacing: "-0.034em",
                color: "var(--ink)",
                lineHeight: 1.08,
                textWrap: "balance",
                marginBottom: 18,
              }}
            >
              The check that stops it before it merges.
            </h2>
            <p style={{ fontSize: 17, color: "var(--muted)", lineHeight: 1.6, maxWidth: 420 }}>
              Arceo runs as a GitHub Action. It scores every agent in the diff,
              posts the report as a comment, and fails the build when one
              crosses the threshold you set.
            </p>

            <div className="pr-facts">
              <div>
                <span className="mono pr-fact-k">threshold</span>
                <span className="mono pr-fact-v">60</span>
              </div>
              <div>
                <span className="mono pr-fact-k">runs on</span>
                <span className="mono pr-fact-v">push · pull_request</span>
              </div>
              <div>
                <span className="mono pr-fact-k">writes</span>
                <span className="mono pr-fact-v">nothing — read-only scan</span>
              </div>
            </div>
          </div>

          {/* ── The panel ────────────────────────────────────────── */}
          <div className="act-dark pr-panel">
            <div className="pr-branch">
              <span className="mono pr-branch-name">feat/refund-automation</span>
              <span className="pr-branch-arrow" aria-hidden="true">
                →
              </span>
              <span className="mono pr-branch-base">main</span>
              <span className="mono pr-num">#248</span>
            </div>

            {/* Checks list */}
            <div className="pr-checks">
              <div className="pr-check">
                <Mark ok />
                <span className="pr-check-name">build</span>
                <span className="mono pr-check-time">1m 12s</span>
              </div>
              <div className="pr-check">
                <Mark ok />
                <span className="pr-check-name">tests</span>
                <span className="mono pr-check-time">2m 04s</span>
              </div>
              <div className={`pr-check pr-check-arceo${done ? " failed" : ""}`}>
                {done ? <Mark ok={false} /> : <Spinner />}
                <span className="pr-check-name">Arceo Agent Security Scan</span>
                <span className="mono pr-check-time">{done ? "38s" : "running"}</span>
              </div>
            </div>

            {/* The report the action posts back */}
            <div className="pr-report">
              <div className="pr-report-head">
                <span className="pr-report-title">Arceo Agent Security Scan</span>
                <span className={`mono pr-verdict${done ? " on" : ""}`}>
                  {done ? "FAIL" : "…"}
                </span>
              </div>

              <div className="mono pr-summary">
                Files scanned <b>12</b> · Agents found <b>3</b> · Max blast radius{" "}
                <b>{done ? 82 : "—"}</b> · Critical chains <b>{done ? 1 : "—"}</b> · Threshold{" "}
                <b>{THRESHOLD}</b>
              </div>

              <div className="pr-agents">
                {AGENTS.map((a, i) => {
                  const isDone = resolved(i);
                  const failed = a.score > THRESHOLD;
                  return (
                    <div key={a.file} className={`pr-agent${isDone ? " in" : ""}`}>
                      <span className="mono pr-agent-file">{a.file}</span>
                      <span className="mono pr-agent-name">{a.name}</span>
                      <span className="mono pr-agent-score">
                        {isDone ? (
                          <>
                            <b className={failed ? "bad" : ""}>{a.score}</b> / 100
                          </>
                        ) : (
                          <span className="pr-agent-wait">scanning</span>
                        )}
                      </span>
                      <span className="pr-agent-verdict">
                        {isDone ? (
                          <span className={`mono pr-pill ${failed ? "fail" : "pass"}`}>
                            {failed ? "FAIL" : "PASS"}
                          </span>
                        ) : (
                          <span className="pr-pill wait" />
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className={`pr-reason${done ? " on" : ""}`}>
                <span className="pr-reason-line">
                  <span className="mono">deploy-bot</span> blast radius{" "}
                  <span className="mono">82</span> exceeds threshold{" "}
                  <span className="mono">60</span>
                </span>
                <span className="pr-reason-chain mono">
                  critical chain · {AGENTS[2].chain}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .pr-grid {
          display: grid;
          grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
          gap: 72px;
          align-items: center;
        }

        .pr-facts {
          margin-top: 32px; padding-top: 22px;
          border-top: 1px solid var(--rule);
          display: flex; flex-direction: column; gap: 11px;
        }
        .pr-facts > div {
          display: flex; align-items: baseline; gap: 14px;
        }
        .pr-fact-k {
          font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
          color: var(--muted-2); width: 82px; flex-shrink: 0;
        }
        .pr-fact-v { font-size: 12px; color: var(--ink); }

        /* ── Panel ────────────────────────────────────────────── */
        .pr-panel {
          border-radius: var(--r-lg);
          border: 1px solid rgba(255,255,255,0.09);
          box-shadow: var(--shadow-xl);
          overflow: hidden;
        }

        .pr-branch {
          display: flex; align-items: center; gap: 9px;
          padding: 14px 20px;
          border-bottom: 1px solid var(--rule);
          background: rgba(255,255,255,0.02);
        }
        .pr-branch-name { font-size: 11.5px; color: var(--ink); }
        .pr-branch-arrow { font-size: 12px; color: var(--muted-2); }
        .pr-branch-base { font-size: 11.5px; color: var(--muted); }
        .pr-num { margin-left: auto; font-size: 11px; color: var(--muted-2); }

        .pr-checks { padding: 6px 20px 10px; border-bottom: 1px solid var(--rule); }
        .pr-check {
          display: flex; align-items: center; gap: 11px;
          height: 38px;
        }
        .pr-check-name { font-size: 12.5px; color: var(--muted); }
        .pr-check-arceo .pr-check-name { color: var(--ink); font-weight: 500; }
        .pr-check-time {
          margin-left: auto; font-size: 10.5px; color: var(--muted-2);
        }
        .pr-mark { display: inline-flex; flex-shrink: 0; }
        .pr-mark.pass { color: #4ade80; }
        .pr-mark.fail { color: #f87171; }
        .pr-spin {
          display: inline-flex; flex-shrink: 0; color: var(--muted);
          animation: pr-rotate 1s linear infinite;
        }
        @keyframes pr-rotate { to { transform: rotate(360deg); } }

        /* ── Report ───────────────────────────────────────────── */
        .pr-report { padding: 18px 20px 20px; }
        .pr-report-head {
          display: flex; align-items: baseline; justify-content: space-between;
          gap: 12px; margin-bottom: 8px;
        }
        .pr-report-title { font-size: 13px; font-weight: 600; color: var(--ink); }
        .pr-verdict {
          font-size: 10px; font-weight: 600; letter-spacing: 0.1em;
          padding: 3px 9px; border-radius: var(--r-xs);
          color: var(--muted-2); background: rgba(255,255,255,0.06);
          transition: color .35s ease, background .35s ease;
        }
        .pr-verdict.on { color: #fff; background: #dc2626; }

        .pr-summary {
          font-size: 10.5px; color: var(--muted-2); line-height: 1.7;
          padding-bottom: 14px; margin-bottom: 6px;
          border-bottom: 1px solid var(--rule);
        }
        .pr-summary b { color: var(--muted); font-weight: 500; }

        .pr-agents { display: flex; flex-direction: column; }
        .pr-agent {
          display: grid;
          grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr) 76px 54px;
          gap: 12px; align-items: center;
          height: 40px;
          border-bottom: 1px solid var(--rule-light);
          opacity: .45;
          transition: opacity .4s ease;
        }
        .pr-agent.in { opacity: 1; }
        .pr-agent:last-child { border-bottom: none; }
        .pr-agent-file {
          font-size: 11px; color: var(--ink);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pr-agent-name { font-size: 11px; color: var(--muted-2); }
        .pr-agent-score { font-size: 11px; color: var(--muted-2); text-align: right; }
        .pr-agent-score b { color: var(--ink); font-weight: 600; }
        .pr-agent-score b.bad { color: #f87171; }
        .pr-agent-wait { font-size: 10px; color: var(--muted-2); }
        .pr-agent-verdict { display: flex; justify-content: flex-end; }
        .pr-pill {
          font-size: 9px; font-weight: 600; letter-spacing: 0.07em;
          padding: 3px 8px; border-radius: var(--r-xs);
          min-width: 44px; text-align: center;
        }
        .pr-pill.pass { color: #4ade80; background: rgba(74,222,128,0.12); }
        .pr-pill.fail { color: #fff; background: #dc2626; }
        .pr-pill.wait {
          background: rgba(255,255,255,0.07); height: 19px; display: block;
        }

        .pr-reason {
          margin-top: 14px; padding: 12px 14px;
          border-radius: var(--r-sm);
          background: rgba(220,38,38,0.10);
          border: 1px solid rgba(220,38,38,0.28);
          display: flex; flex-direction: column; gap: 4px;
          opacity: 0; transform: translateY(6px);
          transition: opacity .4s ease, transform .4s cubic-bezier(.16,1,.3,1);
        }
        .pr-reason.on { opacity: 1; transform: none; }
        .pr-reason-line { font-size: 12.5px; color: #fca5a5; }
        .pr-reason-line .mono { color: #fff; font-size: 11.5px; }
        .pr-reason-chain { font-size: 10.5px; color: rgba(252,165,165,0.75); }

        @media (max-width: 1000px) {
          .pr-grid { grid-template-columns: 1fr !important; gap: 44px !important; }
        }
        @media (max-width: 620px) {
          .pr-agent { grid-template-columns: minmax(0, 1fr) 66px 54px; }
          .pr-agent-name { display: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .pr-spin { animation: none; }
          .pr-agent, .pr-reason, .pr-verdict { transition: none; }
        }
      `}</style>
    </section>
  );
}
