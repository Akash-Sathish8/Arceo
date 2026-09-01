import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AppShell from '@/components/layout/AppShell'
import CommandPalette from '@/components/layout/CommandPalette'
import { ToastContainer } from '@/components/shared/Toast'
import { isLoggedIn } from '@/lib/api'
import Login from '@/pages/Login'

// Route-level code splitting: each page's chunk loads on first visit.
// Login stays eager — it's the entry surface and must paint instantly.
const Authority = lazy(() => import('@/pages/Authority'))
const AgentDetail = lazy(() => import('@/pages/AgentDetail'))
const History = lazy(() => import('@/pages/History'))
const Workflows = lazy(() => import('@/pages/Workflows'))
const Sandbox = lazy(() => import('@/pages/Sandbox'))
const SimulationDetail = lazy(() => import('@/pages/SimulationDetail'))
const SweepDetail = lazy(() => import('@/pages/SweepDetail'))
const Comparison = lazy(() => import('@/pages/Comparison'))
const Settings = lazy(() => import('@/pages/Settings'))
const Approvals = lazy(() => import('@/pages/Approvals'))
const CostPortfolio = lazy(() => import('@/pages/CostPortfolio'))
const SpendDashboard = lazy(() => import('@/pages/SpendDashboard'))
const NotFound = lazy(() => import('@/pages/NotFound'))

// Layout-shaped placeholder while a route chunk loads.
function RouteFallback() {
  return (
    <div style={{ padding: 'var(--page-pad)' }} aria-busy="true">
      <div className="skeleton" style={{ height: 28, width: 220, marginBottom: 18 }} />
      <div className="skeleton" style={{ height: 140 }} />
    </div>
  )
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
    },
  },
})

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (!isLoggedIn()) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppShell>
          <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Authority />
                </ProtectedRoute>
              }
            />
            <Route
              path="/agent/:agentId"
              element={
                <ProtectedRoute>
                  <AgentDetail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/agent/:agentId/spend"
              element={
                <ProtectedRoute>
                  <CostPortfolio />
                </ProtectedRoute>
              }
            />
            <Route
              path="/spend"
              element={
                <ProtectedRoute>
                  <SpendDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/history"
              element={
                <ProtectedRoute>
                  <History />
                </ProtectedRoute>
              }
            />
            <Route path="/executions" element={<Navigate to="/history" replace />} />
            <Route path="/audit" element={<Navigate to="/history?view=audit" replace />} />
            {/* The fleet page lives at "/" — alias the intuitive URL. */}
            <Route path="/agents" element={<Navigate to="/" replace />} />
            <Route
              path="/workflows"
              element={
                <ProtectedRoute>
                  <Workflows />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sandbox"
              element={
                <ProtectedRoute>
                  <Sandbox />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sandbox/:simulationId"
              element={
                <ProtectedRoute>
                  <SimulationDetail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sweep/:sweepId"
              element={
                <ProtectedRoute>
                  <SweepDetail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/compare"
              element={
                <ProtectedRoute>
                  <Comparison />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <Settings />
                </ProtectedRoute>
              }
            />
            <Route
              path="/approvals"
              element={
                <ProtectedRoute>
                  <Approvals />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<ProtectedRoute><NotFound /></ProtectedRoute>} />
          </Routes>
          </Suspense>
        </AppShell>
        <CommandPalette />
        <ToastContainer />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
