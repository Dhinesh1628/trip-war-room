import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import Shell from './components/Shell.jsx';
import AuthPage from './pages/AuthPage.jsx';
import Dashboard from './pages/Dashboard.jsx';
import JoinPage from './pages/JoinPage.jsx';
import TripRoom from './pages/TripRoom.jsx';
import Analytics from './pages/Analytics.jsx';
import Admin from './pages/Admin.jsx';
import './index.css';

// Signed-in pages; anyone else goes to sign in and comes back afterwards.
function Private({ children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <p className="page muted">Loading…</p>;
  if (!user) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  return children;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/signin" element={<AuthPage mode="signin" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route element={<Private><Shell /></Private>}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/join/:code" element={<JoinPage />} />
            <Route path="/trips/:tripId" element={<TripRoom />} />
            <Route path="/trips/:tripId/analytics" element={<Analytics />} />
            <Route path="/admin" element={<Admin />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
