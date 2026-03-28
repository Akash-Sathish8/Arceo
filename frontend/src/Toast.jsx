import { useState, useEffect } from 'react'
import './Toast.css'

let _id = 0

export function toast(message, type = 'success') {
  window.dispatchEvent(new CustomEvent('ag-toast', { detail: { message, type, id: ++_id } }))
}

export function ToastContainer() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    const handler = (e) => {
      const t = e.detail
      setToasts(prev => [...prev, t])
      setTimeout(() => setToasts(prev => prev.filter(x => x.id !== t.id)), 3500)
    }
    window.addEventListener('ag-toast', handler)
    return () => window.removeEventListener('ag-toast', handler)
  }, [])

  if (!toasts.length) return null

  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span className="toast-icon">
            {t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ'}
          </span>
          {t.message}
        </div>
      ))}
    </div>
  )
}
