import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AppShell from '@/components/layout/AppShell'
import CommandPalette from '@/components/layout/CommandPalette'
import { ToastContainer } from '@/components/shared/Toast'
import { isLoggedIn } from '@/lib/api'
import Login from '@/pages/Login'
import Authority from '@/pages/Authority'
import AgentDetail from '@/pages/AgentDetail'
import History from '@/pages/History'
import Workflows from '@/pages/Workflows'
import Sandbox from '@/pages/Sandbox'
import SimulationDetail from '@/pages/SimulationDetail'
import SweepDetail from '@/pages/SweepDetail'
import Comparison from '@/pages/Comparison'
import Settings from '@/pages/Settings'
import Approvals from '@/pages/Approvals'
import CostPortfolio from '@/pages/CostPortfolio'
import SpendDashboard from '@/pages/SpendDashboard'
import NotFound from '@/pages/NotFound'

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
        </AppShell>
        <CommandPalette />
        <ToastContainer />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
