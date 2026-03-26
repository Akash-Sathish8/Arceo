import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import './index.css'
import { isLoggedIn, logout, getUser } from './api.js'
import Login from './Login.jsx'
import Authority from './Authority.jsx'
import AgentDetail from './AgentDetail.jsx'
import AuditLog from './AuditLog.jsx'
import ExecutionLog from './ExecutionLog.jsx'
import Sandbox from './Sandbox.jsx'
import SimulationDetail from './SimulationDetail.jsx'

function ProtectedRoute({ children }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />
  return children
}

function Nav() {
  const location = useLocation()
  if (location.pathname === '/login') return null

  const user = getUser()

  return (
    <nav className="top-nav">
      <div className="nav-brand">ActionGate</div>
      <div className="nav-links">
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/sandbox">Sandbox</NavLink>
        <NavLink to="/executions">Executions</NavLink>
        <NavLink to="/audit">Audit Log</NavLink>
      </div>
      <div className="nav-right">
        {user && <span className="nav-user">{user.email}</span>}
        <button className="nav-logout" onClick={logout}>Logout</button>
      </div>
    </nav>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Nav />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProtectedRoute><Authority /></ProtectedRoute>} />
        <Route path="/agent/:agentId" element={<ProtectedRoute><AgentDetail /></ProtectedRoute>} />
        <Route path="/audit" element={<ProtectedRoute><AuditLog /></ProtectedRoute>} />
        <Route path="/executions" element={<ProtectedRoute><ExecutionLog /></ProtectedRoute>} />
        <Route path="/sandbox" element={<ProtectedRoute><Sandbox /></ProtectedRoute>} />
        <Route path="/sandbox/:simulationId" element={<ProtectedRoute><SimulationDetail /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
