"use client";

import { useEffect, useRef } from "react";
import { C } from "@/lib/palette";
import { RISK } from "@/lib/labels";

/* The authority graph, as a trace field.
 *
 * The previous version drifted every node on its own sine wave. Nodes that
 * wander independently read as a screensaver: nothing is where it was a
 * second ago, so the eye never resolves a shape, and the "chains" never
 * looked like chains. The fix is not more motion, it is less — and putting
 * what is left on the thing the product actually does.
 *
 * So: the layout is FIXED. What moves is a call. A packet walks a real route
 * through the graph, hop by hop, the way an agent works through its tools.
 * Most edges are ordinary. A few are transitions the chain detector flags —
 * money, then deletion; PII, then anything outbound — and when a packet
 * crosses one of those, the edge ignites red and decays behind it. The red
 * is never ambient: it only ever appears where something dangerous just
 * happened. That is the entire graphic, and it is the entire product.
 *
 * Painted by writing SVG attributes from one rAF loop with cached element
 * refs — never through React state, so the hero does not re-render at 60fps. */

type Kind = "system" | "risk" | "hop";

type Node = {
  x: number; // percent
  y: number; // percent
  r: number;
  kind: Kind;
  label?: string;
};

/* Positions are a composition, not a simulation. Systems anchor the four
   corners, the two capabilities that cost real money sit on the diagonal
   between them, and the hops thread the gaps. The headline column
   (roughly 20–50% across, vertically centred) is deliberately left open. */
const NODES: Node[] = [
  { x:  9, y: 21, r: 15, kind: "system", label: "CRM" },
  { x: 91, y: 16, r: 15, kind: "system", label: "Payments" },
  { x: 87, y: 81, r: 15, kind: "system", label: "Database" },
  { x: 13, y: 83, r: 15, kind: "system", label: "Email" },

  /* Held off the bottom centre. A lone red dot under the middle of the
     headline reads as a stray mark, not a capability. */
  { x: 78, y: 45, r: 10, kind: "risk", label: RISK.moves_money.plain },
  { x: 64, y: 89, r: 10, kind: "risk", label: RISK.deletes_data.plain },

  { x: 26, y: 12, r: 5, kind: "hop" },
  { x: 57, y: 27, r: 5, kind: "hop" },
  { x: 35, y: 57, r: 5, kind: "hop" },
  { x: 72, y: 68, r: 5, kind: "hop" },
  { x: 21, y: 62, r: 5, kind: "hop" },
  { x: 86, y: 60, r: 5, kind: "hop" },
];

/* `risk` marks a transition the chain detector would flag. These are the
   only edges that can ever show colour. */
const EDGES: [number, number, boolean][] = [
  [0, 6, false],
  [6, 7, false],
  [7, 1, false],
  [1, 4, true],
  [4, 11, true],
  [11, 2, true],
  [2, 9, false],
  [9, 5, true],
  [5, 3, true],
  [3, 10, false],
  [10, 8, false],
  [8, 0, false],
  [8, 4, true],
  [7, 9, false],
];

/* Index every edge by its endpoints so a route can look up which edge it is
   walking without a linear scan each frame. */
const EDGE_INDEX = new Map<string, number>();
EDGES.forEach(([a, b], i) => {
  EDGE_INDEX.set(`${a}-${b}`, i);
  EDGE_INDEX.set(`${b}-${a}`, i);
});

/* Closed routes through the graph. Each is a plausible working path for one
   agent: read a record, act on it, write somewhere else, come back. */
const ROUTES: number[][] = [
  [0, 6, 7, 1, 4, 11, 2, 9, 5, 3, 10, 8, 0],
  [8, 4, 11, 2, 9, 5, 3, 10, 8],
  [0, 6, 7, 9, 5, 3, 10, 8, 0],
];

type Packet = { route: number[]; leg: number; t: number; speed: number };

export default function AuthorityGraph({
  tone = "light",
  mask = true,
  packets = 2,
  variant = "subject",
  alert = false,
}: {
  /* On a dark act the system nodes have to invert or they vanish into the
     background. Risk nodes keep their red either way: that colour means the
     same thing on both surfaces. */
  tone?: "light" | "dark";
  mask?: boolean;
  /* How many calls are in flight. Two on the hero, where the graph is
     wallpaper; three in the dark act, where it is the subject. */
  packets?: number;
  /* "ambient" is wallpaper — smaller, fainter, and unlabelled, because a
     legible tool name behind a headline is just competition for the eye.
     "subject" is the dark act, where the graph is what you are looking at. */
  variant?: "ambient" | "subject";
  /* Raised while something elsewhere on the page has actually detected a
     chain. In the hero that is the tape: the moment it brackets a pair, every
     flagged edge behind the headline lights at once. The two graphics are
     showing the same event from two angles, which is the point — a chain is
     not a row in a log, it is a path through the agent's authority. */
  alert?: boolean;
} = {}) {
  const svgRef = useRef<SVGSVGElement>(null);
  /* Read through a ref so raising the alert never restarts the paint loop. */
  const alertRef = useRef(alert);
  alertRef.current = alert;
  const dark = tone === "dark";
  const ambient = variant === "ambient";
  /* Smaller as wallpaper. At full size the four unlabelled system nodes read
     as stray blobs in the corners rather than as a network — the lines are
     what should register behind the type, not the dots. */
  const rs = ambient ? 0.52 : 1; // radius scale

  const systemFill = dark ? "#DDE4EE" : C.ink;
  const hopFill = dark ? "#1C2331" : C.paper;
  const hopStroke = dark ? "rgba(255,255,255,0.24)" : C.rule;
  const edgeStroke = dark ? "rgba(255,255,255,0.14)" : "#E1E5EA";
  const labelFill = dark ? "#6B7688" : C.muted2;
  const packetFill = dark ? "#F4F6F8" : C.ink;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    /* Cache every element once. querySelector inside a 60fps loop is the
       kind of thing that makes a hero feel heavy on a laptop. */
    const nodeEls = NODES.map((_, i) => svg.querySelector<SVGGElement>(`[data-n="${i}"]`));
    const haloEls = NODES.map((_, i) => svg.querySelector<SVGCircleElement>(`[data-halo="${i}"]`));
    const edgeEls = EDGES.map((_, i) => svg.querySelector<SVGLineElement>(`[data-e="${i}"]`));
    const packetEls = Array.from({ length: packets }, (_, i) =>
      svg.querySelector<SVGCircleElement>(`[data-p="${i}"]`),
    );

    const still = window.matchMedia("(prefers-reduced-motion: reduce)");

    /* Stagger the packets around their routes so they are never in step. */
    const state: Packet[] = Array.from({ length: packets }, (_, i) => {
      const route = ROUTES[i % ROUTES.length];
      return {
        route,
        leg: Math.floor((i / packets) * (route.length - 1)),
        t: (i * 0.37) % 1,
        speed: 0.42 + i * 0.07,
      };
    });

    /* Per-edge ignition, decayed every frame. */
    const flare = new Float32Array(EDGES.length);
    /* Per-node arrival pulse, same idea. */
    const pulse = new Float32Array(NODES.length);

    let raf = 0;
    let last = 0;

    const paint = (ms: number) => {
      const w = svg.clientWidth || 1;
      const h = svg.clientHeight || 1;
      const dt = last ? Math.min((ms - last) / 1000, 0.05) : 0;
      last = ms;

      const px = (n: Node) => (n.x / 100) * w;
      const py = (n: Node) => (n.y / 100) * h;

      /* Nodes hold their positions. Placing them once, in pixels, each
         frame is what makes this cheap and what makes it look composed. */
      NODES.forEach((n, i) => {
        nodeEls[i]?.setAttribute("transform", `translate(${px(n)},${py(n)})`);
      });

      EDGES.forEach(([a, b], i) => {
        const el = edgeEls[i];
        if (!el) return;
        el.setAttribute("x1", String(px(NODES[a])));
        el.setAttribute("y1", String(py(NODES[a])));
        el.setAttribute("x2", String(px(NODES[b])));
        el.setAttribute("y2", String(py(NODES[b])));
      });

      if (!still.matches) {
        /* Decay first, then re-ignite whatever is currently under a packet.
           An edge therefore stays lit for as long as the call is on it and
           fades over about half a second after it leaves. */
        for (let i = 0; i < flare.length; i++) flare[i] = Math.max(0, flare[i] - dt * 2.2);
        for (let i = 0; i < pulse.length; i++) pulse[i] = Math.max(0, pulse[i] - dt * 1.8);

        /* Under alert every flagged edge holds lit and both capabilities
           breathe, rather than only the one edge a packet happens to be on. */
        if (alertRef.current) {
          EDGES.forEach(([, , isRisk], i) => {
            if (isRisk) flare[i] = Math.max(flare[i], 0.55 + Math.sin(ms / 320) * 0.3);
          });
          NODES.forEach((n, i) => {
            if (n.kind === "risk") pulse[i] = Math.max(pulse[i], 0.5 + Math.sin(ms / 420) * 0.4);
          });
        }

        state.forEach((p, pi) => {
          p.t += dt * p.speed;
          while (p.t >= 1) {
            p.t -= 1;
            p.leg = (p.leg + 1) % (p.route.length - 1);
            /* Arrival: the node the call just reached takes the pulse. */
            pulse[p.route[p.leg]] = 1;
          }

          const from = NODES[p.route[p.leg]];
          const to = NODES[p.route[p.leg + 1]];
          const e = EDGE_INDEX.get(`${p.route[p.leg]}-${p.route[p.leg + 1]}`);

          /* Ease within a leg so the call settles into each hop instead of
             sliding through at constant speed — it reads as work being
             done rather than a dot on a track. */
          const t = p.t < 0.5 ? 2 * p.t * p.t : 1 - Math.pow(-2 * p.t + 2, 2) / 2;

          if (e !== undefined && EDGES[e][2]) flare[e] = 1;

          const el = packetEls[pi];
          if (el) {
            el.setAttribute("cx", String(px(from) + (px(to) - px(from)) * t));
            el.setAttribute("cy", String(py(from) + (py(to) - py(from)) * t));
            el.setAttribute("fill", e !== undefined && EDGES[e][2] ? C.critical : packetFill);
          }
        });

        EDGES.forEach(([, , isRisk], i) => {
          const el = edgeEls[i];
          if (!el || !isRisk) return;
          const f = flare[i];
          el.setAttribute("stroke", f > 0.02 ? C.critical : edgeStroke);
          el.setAttribute("opacity", String(0.34 + f * 0.5));
          el.setAttribute("stroke-width", String(1 + f * 0.5));
        });

        NODES.forEach((n, i) => {
          const el = haloEls[i];
          if (!el) return;
          /* Halo blooms on arrival, then relaxes. Risk nodes bloom wider —
             that is the moment the product would raise a chain. */
          const amp = n.kind === "risk" ? 1 : 0.45;
          el.setAttribute("r", String(n.r * rs + 7 + pulse[i] * 9 * amp));
          el.setAttribute("opacity", String((n.kind === "risk" ? 0.09 : 0.05) + pulse[i] * 0.14 * amp));
        });
      }

      raf = requestAnimationFrame(paint);
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [packets, edgeStroke, packetFill, rs]);

  return (
    <svg
      ref={svgRef}
      width="100%"
      height="100%"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        display: "block",
        pointerEvents: "none",
        /* Wallpaper is held well back. The graph should register as a
           substrate you notice on second look, never as competition for
           the headline sitting on top of it. */
        opacity: ambient ? 0.62 : 1,
        /* Dim — not erase — over the headline column. Masking to fully
           transparent swallows the red nodes, which are the point. */
        WebkitMaskImage: mask
          ? "radial-gradient(46% 42% at 31% 50%, rgba(0,0,0,0.1) 20%, #000 88%)"
          : undefined,
        maskImage: mask
          ? "radial-gradient(46% 42% at 31% 50%, rgba(0,0,0,0.1) 20%, #000 88%)"
          : undefined,
      }}
    >
      {EDGES.map(([, , isRisk], i) => (
        <line
          key={i}
          data-e={i}
          stroke={edgeStroke}
          strokeWidth={1}
          strokeDasharray={isRisk ? "3 5" : undefined}
          opacity={isRisk ? 0.34 : 0.85}
        />
      ))}

      {/* Halos sit under every node so the pulse never clips a neighbour. */}
      {NODES.map((n, i) => (
        <g key={`h-${i}`} data-n={i}>
          <circle
            data-halo={i}
            r={n.r * rs + 7}
            fill={n.kind === "risk" ? C.critical : dark ? "#FFFFFF" : C.ink}
            opacity={n.kind === "risk" ? 0.09 : 0.05}
          />
          <circle
            r={n.r * rs}
            fill={n.kind === "system" ? systemFill : n.kind === "risk" ? C.critical : hopFill}
            stroke={n.kind === "hop" ? hopStroke : "none"}
            strokeWidth={n.kind === "hop" ? 1.5 : 0}
            opacity={n.kind === "system" ? 0.92 : n.kind === "risk" ? 0.88 : 1}
          />
          {n.label && !ambient && (
            <text
              y={n.r + 15}
              textAnchor="middle"
              fontSize={9.5}
              fill={n.kind === "risk" ? C.critical : labelFill}
              style={{ fontFamily: "var(--font-sans), system-ui, sans-serif", letterSpacing: "0.01em" }}
            >
              {n.label}
            </text>
          )}
        </g>
      ))}

      {/* The calls in flight. */}
      {Array.from({ length: packets }, (_, i) => (
        <circle key={`p-${i}`} data-p={i} r={ambient ? 2.6 : 3.2} fill={packetFill} opacity={0.9} />
      ))}
    </svg>
  );
}
