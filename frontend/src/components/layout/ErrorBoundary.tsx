import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** When this changes (e.g. the route path), a crashed boundary resets so the
   *  user can navigate away instead of being stuck until a hard reload. */
  resetKey?: unknown
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidUpdate(prev: Props) {
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null })
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '70vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div
            style={{
              background: 'var(--card)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)',
              padding: 32, maxWidth: 440, width: '100%', textAlign: 'center',
            }}
          >
            <h2 style={{ fontSize: 'var(--fs-title)', fontWeight: 600, color: 'var(--ink-900)', marginBottom: 6 }}>
              Something went wrong on this page
            </h2>
            <p style={{ fontSize: 'var(--fs-small)', color: 'var(--ink-500)', marginBottom: 20, lineHeight: 1.5 }}>
              The rest of Arceo is fine. You can retry, or head back to your agents.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="ag-btn"
                style={{
                  padding: '8px 16px', background: 'var(--accent)', color: '#fff',
                  fontSize: 'var(--fs-small)', fontWeight: 600, border: 'none',
                  borderRadius: 'var(--radius-md)', cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <a
                href="/"
                className="ag-btn"
                style={{
                  padding: '8px 16px', background: 'var(--card)', color: 'var(--ink-700)',
                  fontSize: 'var(--fs-small)', fontWeight: 600, textDecoration: 'none',
                  border: '1px solid var(--line)', borderRadius: 'var(--radius-md)',
                }}
              >
                Back to agents
              </a>
            </div>
            {this.state.error?.message && (
              <details style={{ marginTop: 18, textAlign: 'left' }}>
                <summary style={{ fontSize: 'var(--fs-small)', color: 'var(--ink-400)', cursor: 'pointer' }}>
                  Technical details
                </summary>
                <p className="mono" style={{ fontSize: 11, color: 'var(--ink-500)', marginTop: 8, wordBreak: 'break-all' }}>
                  {this.state.error.message}
                </p>
              </details>
            )}
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
