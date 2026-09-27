import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Check } from 'lucide-react'

export type BundledFile = { path: string; chars: number; truncated?: boolean }

const NAME_SKIP = new Set([
  'main', 'run', 'dispatch', 'init', 'setup', 'cli', 'app', 'start', 'entrypoint',
  'loop', 'chat', 'agent', 'require', 'import', 'log', 'print', 'test',
])

/** Cheap client-side guess at the tool/function names in a code bundle.
 *  Purely for the teaser graph; the backend does the real extraction. */
export function spotToolNames(content: string): string[] {
  const found: string[] = []
  const push = (raw: string | undefined) => {
    if (!raw) return
    const name = raw.trim()
    if (!name || name.startsWith('_') || NAME_SKIP.has(name.toLowerCase())) return
    if (/^test/i.test(name)) return
    if (!found.includes(name)) found.push(name)
  }
  let m: RegExpExecArray | null
  const pyDef = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm
  while ((m = pyDef.exec(content))) push(m[1])
  const jsFn = /(?:^|[\s;])(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g
  while ((m = jsFn.exec(content))) push(m[1])
  const jsArrow = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g
  while ((m = jsArrow.exec(content))) push(m[1])
  // Declarative tool manifests (OpenAI / Anthropic / MCP JSON or YAML).
  if (/\b(tools|functions|input_schema|parameters)\b/.test(content)) {
    const nameKey = /["']?name["']?\s*:\s*["']([A-Za-z_][\w.-]{2,})["']/g
    while ((m = nameKey.exec(content))) push(m[1])
  }
  return found.slice(0, 12)
}

const W = 320
const H = 224
const CX = W / 2
const CY = H / 2

type Node = { x: number; y: number; ux: number; uy: number; label?: string; anchor: 'start' | 'end' | 'middle' }

function layout(labels: string[], placeholders: number, ring: { rx: number; ry: number } | null): Node[] {
  const n = labels.length || placeholders
  const nodes: Node[] = []
  const rx = ring ? ring.rx : n <= 6 ? 112 : 128
  const ry = ring ? ring.ry : n <= 6 ? 70 : 84
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    const x = CX + cos * rx
    const y = CY + sin * ry
    // Unit vector from hub to node, so edges can stop short of both circles.
    const len = Math.hypot(x - CX, y - CY) || 1
    // Labels sit beside side nodes and above / below the near-vertical ones,
    // always on the outside of the ring so they never cross an edge.
    const anchor = Math.abs(cos) < 0.2 ? 'middle' : cos > 0 ? 'start' : 'end'
    nodes.push({ x, y, ux: (x - CX) / len, uy: (y - CY) / len, label: labels[i], anchor })
  }
  return nodes
}

function trunc(s: string, n = 18) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

const STAGES = ['Reading code', 'Finding tool definitions', 'Classifying risk', 'Mapping dangerous chains']
const STAGE_AT = [0, 2, 6, 12]

const NODE_R = 5
const HUB_R = 9
const HUB_LABEL_DROP = 22
// Side labels extend past the ring; the viewBox reserves room for them so
// they never clip against the flex container when the stage list is shown.
const LABEL_GUTTER = 84

function TeaserGraph({ labels, hub, mode }: { labels: string[]; hub?: string; mode: 'empty' | 'loaded' | 'analyzing' }) {
  const placeholder = labels.length === 0
  const faint = mode === 'empty'
  const nodes = useMemo(() => layout(labels, 5, faint ? { rx: 100, ry: 56 } : null), [labels, faint])
  const stroke = faint ? 'var(--border)' : placeholder ? 'var(--border-strong)' : 'var(--text-primary)'
  const hubLabel = hub ? trunc(hub, 26) : undefined
  const hubLabelW = hubLabel ? hubLabel.length * 5.6 + 12 : 0
  return (
    <svg viewBox={`-${LABEL_GUTTER} 0 ${W + LABEL_GUTTER * 2} ${H}`} width="100%" style={{ maxWidth: 520, height: 'auto', display: 'block', margin: '0 auto' }} aria-hidden>
      {nodes.map((nd, i) => {
        // Start past the hub circle; edges heading down also clear the hub label.
        const under = hubLabel && nd.uy > 0.25 && Math.abs(nd.ux) * (HUB_LABEL_DROP / Math.max(nd.uy, 0.01)) < hubLabelW / 2 + 4
        // Empty state: short outer spokes only, so nothing pokes out from
        // behind the copy block sitting over the hub.
        const startR = faint ? Math.hypot(nd.x - CX, nd.y - CY) * 0.62 : under ? HUB_R + HUB_LABEL_DROP + 6 : HUB_R + 3
        const endR = NODE_R + 2
        const x1 = CX + nd.ux * startR
        const y1 = CY + nd.uy * startR
        const x2 = nd.x - nd.ux * endR
        const y2 = nd.y - nd.uy * endR
        return (
          <motion.line
            key={`e${i}`}
            x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={stroke}
            strokeWidth={1}
            strokeDasharray={mode === 'analyzing' ? undefined : placeholder || faint ? '2 4' : undefined}
            className={mode === 'analyzing' ? 'sim-edge-flow' : undefined}
            initial={faint ? false : { opacity: 0 }}
            animate={{ opacity: faint ? 0.6 : 1 }}
            transition={{ delay: 0.05 * i, duration: 0.25 }}
          />
        )
      })}
      {nodes.map((nd, i) => {
        const above = nd.y < CY
        const lx = nd.anchor === 'start' ? nd.x + 9 : nd.anchor === 'end' ? nd.x - 9 : nd.x
        const ly = nd.anchor === 'middle' ? (above ? nd.y - 11 : nd.y + 17) : nd.y + (above ? 1 : 5)
        return (
          <motion.g
            key={`n${i}`}
            initial={faint ? false : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.08 + 0.05 * i, duration: 0.3 }}
            style={{ transformOrigin: `${nd.x}px ${nd.y}px` }}
          >
            <circle cx={nd.x} cy={nd.y} r={NODE_R} fill="var(--bg-card)" stroke={stroke} strokeWidth={1.5} strokeDasharray={placeholder ? '2 2' : undefined} />
            {nd.label && (
              <text x={lx} y={ly} textAnchor={nd.anchor} fontSize={8.5} fontFamily="var(--font-code)" fill="var(--text-secondary)">{trunc(nd.label)}</text>
            )}
          </motion.g>
        )
      })}
      {!faint && (
        <>
          {mode === 'analyzing' && <circle cx={CX} cy={CY} r={HUB_R} fill="var(--color-accent)" className="sim-pulse" style={{ transformBox: 'fill-box', transformOrigin: 'center' }} />}
          <circle cx={CX} cy={CY} r={HUB_R} fill="var(--text-primary)" />
        </>
      )}
      {hubLabel && (
        <>
          <rect x={CX - hubLabelW / 2} y={CY + HUB_LABEL_DROP - 11} width={hubLabelW} height={15} rx={3} fill="var(--bg-card)" />
          <text x={CX} y={CY + HUB_LABEL_DROP} textAnchor="middle" fontSize={9.5} fontWeight={600} fontFamily="var(--font-sans)" fill="var(--text-primary)">{hubLabel}</text>
        </>
      )}
      {mode === 'analyzing' && (
        <g className="scan-line">
          <rect x={-LABEL_GUTTER} y={-3} width={W + LABEL_GUTTER * 2} height={1} fill="var(--color-accent)" opacity={0.35} />
          <rect x={-LABEL_GUTTER} y={0} width={W + LABEL_GUTTER * 2} height={1.5} fill="var(--color-accent)" />
        </g>
      )}
    </svg>
  )
}

function Stages({ active }: { active: boolean }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!active) { setElapsed(0); return }
    const t0 = Date.now()
    const id = window.setInterval(() => setElapsed((Date.now() - t0) / 1000), 250)
    return () => window.clearInterval(id)
  }, [active])
  const idx = STAGE_AT.filter((s) => elapsed >= s).length - 1
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: '6px 22px', fontSize: 12.5, marginTop: 4 }}>
      {STAGES.map((label, i) => {
        const state = i < idx ? 'done' : i === idx ? 'active' : 'pending'
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7, color: state === 'pending' ? 'var(--text-muted)' : state === 'active' ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: state === 'active' ? 600 : 400, whiteSpace: 'nowrap' }}>
            <span style={{ width: 12, height: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {state === 'done' ? <Check size={11} strokeWidth={2.5} />
                : <span className={state === 'active' ? 'stage-dot-active' : undefined} style={{ width: 6, height: 6, borderRadius: 3, background: state === 'active' ? 'var(--color-accent)' : 'var(--border-strong)' }} />}
            </span>
            {label}
          </div>
        )
      })}
      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {elapsed.toFixed(0)}s · usually under 30s
      </span>
    </div>
  )
}

type Props = {
  filename: string
  content: string
  bundledFiles: BundledFile[]
  bundling: boolean
  dragOver: boolean
  analyzing: boolean
  onDragOver: React.DragEventHandler<HTMLDivElement>
  onDragLeave: React.DragEventHandler<HTMLDivElement>
  onDrop: React.DragEventHandler<HTMLDivElement>
  onPickFiles: () => void
  onPickFolder: () => void
}

export default function AgentDropzone({ filename, content, bundledFiles, bundling, dragOver, analyzing, onDragOver, onDragLeave, onDrop, onPickFiles, onPickFolder }: Props) {
  const labels = useMemo(() => (content ? spotToolNames(content) : []), [content])
  const loaded = !!filename && !!content
  const mode: 'empty' | 'loaded' | 'analyzing' = analyzing ? 'analyzing' : loaded ? 'loaded' : 'empty'
  const hub = loaded ? filename.replace(/\.[^.]+$/, '') : undefined

  return (
    <div className="space-y-3">
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={analyzing ? undefined : onPickFiles}
        style={{
          position: 'relative',
          border: `1px solid ${dragOver ? 'var(--border-strong)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-lg)',
          background: dragOver ? 'var(--bg-sunken)' : 'var(--bg-card)',
          padding: mode === 'empty' ? '28px 20px 22px' : '22px 20px 18px',
          cursor: analyzing ? 'default' : 'pointer',
          transition: 'background .15s, border-color .15s',
        }}
      >
        {mode === 'empty' ? (
          <div style={{ position: 'relative' }}>
            <div style={{ opacity: dragOver ? 0.9 : 0.55, transition: 'opacity .15s' }}>
              <TeaserGraph labels={[]} mode="empty" />
            </div>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <div style={{ textAlign: 'center', background: dragOver ? 'var(--bg-sunken)' : 'var(--bg-card)', padding: '8px 18px', borderRadius: 'var(--radius-md)', transition: 'background .15s' }}>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {bundling ? 'Bundling files…' : dragOver ? 'Release to map this agent' : 'Drop a file or folder of agent code'}
                </p>
                {!bundling && (
                  <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'var(--font-code)' }}>
                    .py .ts .js .json .yaml · or click to browse
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div>
            <TeaserGraph labels={labels} hub={hub} mode={mode} />
            {analyzing && <Stages active={analyzing} />}
          </div>
        )}

        {mode !== 'empty' && (
          <p style={{ margin: '14px 0 0', textAlign: 'center', fontSize: 11.5, color: 'var(--text-muted)' }}>
            {labels.length > 0
              ? `${labels.length} likely tool${labels.length === 1 ? '' : 's'} spotted`
              : 'No tool definitions spotted yet, Arceo will look deeper'}
            {' · '}
            {bundledFiles.length > 0
              ? `${bundledFiles.length} files · ${content.length.toLocaleString()} chars bundled`
              : `${content.length.toLocaleString()} chars loaded`}
            {!analyzing && ' · click to replace'}
          </p>
        )}

        {!analyzing && (
          <p style={{ margin: '10px 0 0', textAlign: 'center', fontSize: 11.5, color: 'var(--text-muted)' }}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onPickFolder() }}
              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--text-secondary)', textDecoration: 'underline', textUnderlineOffset: 3, cursor: 'pointer' }}
            >
              Choose a whole folder
            </button>
            {' '}and it is bundled into one agent
          </p>
        )}
      </div>

      {bundledFiles.length > 0 && (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 12, maxHeight: 240, overflow: 'auto' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
            Bundled into one agent, {bundledFiles.length} files
          </div>
          {bundledFiles.map((b, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, padding: '2px 0' }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: b.truncated ? 'var(--caution)' : 'var(--safe)' }} />
              <code style={{ fontFamily: 'var(--font-code)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{b.path}</code>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-num)' }}>{b.chars.toLocaleString()} chars{b.truncated ? ' (truncated to fit)' : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
