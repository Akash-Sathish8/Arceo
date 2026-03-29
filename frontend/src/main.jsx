import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, NavLink, Link, Navigate, useLocation } from 'react-router-dom'
import './index.css'
import { isLoggedIn, logout, getUser } from './api.js'
import Login from './Login.jsx'
import Authority from './Authority.jsx'
import AgentDetail from './AgentDetail.jsx'
import History from './History.jsx'
import Sandbox from './Sandbox.jsx'
import SimulationDetail from './SimulationDetail.jsx'
import Comparison from './Comparison.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import { ToastContainer } from './Toast.jsx'

function ProtectedRoute({ children }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />
  return children
}

const DashboardIcon = () => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="1" width="5.5" height="5.5" rx="1.2" fill="currentColor"/>
    <rect x="8.5" y="1" width="5.5" height="5.5" rx="1.2" fill="currentColor"/>
    <rect x="1" y="8.5" width="5.5" height="5.5" rx="1.2" fill="currentColor"/>
    <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1.2" fill="currentColor"/>
  </svg>
)

const SandboxIcon = () => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M13 7.5C13 10.5376 10.5376 13 7.5 13C4.46243 13 2 10.5376 2 7.5C2 4.46243 4.46243 2 7.5 2C10.5376 2 13 4.46243 13 7.5Z" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M6 5.5L10 7.5L6 9.5V5.5Z" fill="currentColor"/>
  </svg>
)

const HistoryIcon = () => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="7.5" cy="7.5" r="5.5" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M7.5 4.5V7.5L9.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
)

const CollapseIcon = ({ collapsed }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    {collapsed
      ? <path d="M5 2.5L9.5 7L5 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
      : <path d="M9 2.5L4.5 7L9 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    }
  </svg>
)

function Sidebar({ collapsed, onToggle }) {
  const user = getUser()
  const initial = user?.email?.[0]?.toUpperCase() || 'A'
  const orgName = user?.email?.split('@')[1]?.split('.')[0] || 'workspace'

  return (
    <aside className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}>
      <div className="sidebar-top">
        {!collapsed && (
          <Link to="/" className="sidebar-logo">
            ActionGate<span className="logo-dot" />
          </Link>
        )}
        <button className="sidebar-collapse-btn" onClick={onToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <CollapseIcon collapsed={collapsed} />
        </button>
      </div>

      {!collapsed && (
        <div className="sidebar-cta-wrap">
          <Link to="/?connect=true" className="sidebar-cta">
            <PlusIcon /> Connect Agent
          </Link>
        </div>
      )}
      {collapsed && (
        <div className="sidebar-cta-wrap">
          <Link to="/?connect=true" className="sidebar-cta sidebar-cta-icon" title="Connect Agent">
            <PlusIcon />
          </Link>
        </div>
      )}

      <nav className="sidebar-nav">
        <NavLink to="/" end title="Dashboard" className={({ isActive }) => isActive ? 'active' : ''}>
          <DashboardIcon />{!collapsed && ' Dashboard'}
        </NavLink>
        <NavLink to="/sandbox" title="Sandbox — simulate agent behavior" className={({ isActive }) => isActive ? 'active' : ''}>
          <SandboxIcon />{!collapsed && ' Sandbox'}
        </NavLink>
        <NavLink to="/history" title="Past simulation runs" className={({ isActive }) => isActive ? 'active' : ''}>
          <HistoryIcon />{!collapsed && ' History'}
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        {!collapsed && (
          <>
            <div className="sidebar-user-row">
              <div className="sidebar-avatar">{initial}</div>
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">{orgName}</span>
                <span className="sidebar-user-email">{user?.email}</span>
              </div>
            </div>
            <div className="sidebar-footer-actions">
              <a href="mailto:support@actiongate.io" className="sidebar-help-link">Help &amp; support</a>
              <button className="sidebar-logout" onClick={logout}>Sign out</button>
            </div>
          </>
        )}
        {collapsed && (
          <div className="sidebar-footer-collapsed">
            <div className="sidebar-avatar sidebar-avatar-sm" title={user?.email}>{initial}</div>
          </div>
        )}
      </div>
    </aside>
  )
}

function AppLayout({ children }) {
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const noSidebar = location.pathname === '/login'
  if (noSidebar || !isLoggedIn()) return children
  return (
    <div className="app-layout">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} />
      <div className="main-content">
        {children}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <ToastContainer />
        <AppLayout>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<ProtectedRoute><Authority /></ProtectedRoute>} />
            <Route path="/agent/:agentId" element={<ProtectedRoute><AgentDetail /></ProtectedRoute>} />
            <Route path="/history" element={<ProtectedRoute><History /></ProtectedRoute>} />
            <Route path="/executions" element={<Navigate to="/history" replace />} />
            <Route path="/audit" element={<Navigate to="/history" replace />} />
            <Route path="/sandbox" element={<ProtectedRoute><Sandbox /></ProtectedRoute>} />
            <Route path="/sandbox/:simulationId" element={<ProtectedRoute><SimulationDetail /></ProtectedRoute>} />
            <Route path="/compare" element={<ProtectedRoute><Comparison /></ProtectedRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppLayout>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
