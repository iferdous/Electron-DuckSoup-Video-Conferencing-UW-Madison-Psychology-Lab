import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

type ErrorBoundaryState = { error: Error | null }

// Turns a renderer crash (e.g. the automatic smile detection failing to start) into a readable
// error + Reload button instead of a blank white screen, and logs the real error to the console so
// the root cause is diagnosable. Note: React error boundaries catch errors thrown during render /
// lifecycle, not inside async callbacks (those are already guarded in App with try/catch).
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[SyncLink] Renderer crashed:', error, info)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (error) {
      return (
        <div
          style={{
            minHeight: '100vh',
            padding: 24,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            background: '#0f172a',
            color: '#f1f5f9'
          }}
        >
          <div style={{ maxWidth: 760, margin: '40px auto', background: '#1e293b', padding: 24, borderRadius: 12 }}>
            <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
            <p>
              The app hit an error and stopped. If you had just turned on <strong>Automatic smile synchrony</strong>,
              it most likely couldn&rsquo;t start on this computer &mdash; you can run the study without it (leave that
              setting on <strong>Off</strong>). Please copy the message below when reporting this.
            </p>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                background: '#0b1220',
                color: '#fca5a5',
                padding: 12,
                borderRadius: 8,
                fontSize: 12,
                overflow: 'auto',
                maxHeight: 320
              }}
            >
              {String(error.message)}
              {'\n\n'}
              {String(error.stack ?? '')}
            </pre>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 16px',
                fontSize: 14,
                cursor: 'pointer',
                borderRadius: 8,
                border: 'none',
                background: '#3b82f6',
                color: 'white'
              }}
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
