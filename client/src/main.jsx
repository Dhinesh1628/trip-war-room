import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { I18nProvider, useI18n } from './lib/i18n.jsx';
import { SavedProvider } from './lib/saved.jsx';
import Shell from './components/Shell.jsx';
import AuthPage from './pages/AuthPage.jsx';
import HomePage from './pages/HomePage.jsx';
import ExplorePage from './pages/ExplorePage.jsx';
import JoinPage from './pages/JoinPage.jsx';
import TripRoom from './pages/TripRoom.jsx';
import Analytics from './pages/Analytics.jsx';
import Admin from './pages/Admin.jsx';
import TripsPage from './pages/TripsPage.jsx';
import SavedPage from './pages/SavedPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import AccountPage from './pages/AccountPage.jsx';
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage, PrivacyPage, TestInboxPage } from './pages/AccountFlows.jsx';
import { registerServiceWorker } from './lib/pwa.js';
import './index.css';
import './features.css';

// Signed-in pages; anyone else goes to sign in and comes back afterwards.
function Private({ children }) {
  const { user, ready } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  if (!ready) return <p className="page muted">{t('Loading…')}</p>;
  if (!user) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  return children;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/signin" element={<AuthPage mode="signin" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/dev/inbox" element={<TestInboxPage />} />
      <Route element={<Private><SavedProvider><Shell /></SavedProvider></Private>}>
        <Route path="/" element={<HomePage />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/trips" element={<TripsPage />} />
        <Route path="/saved" element={<SavedPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/join/:code" element={<JoinPage />} />
        <Route path="/trips/:tripId" element={<TripRoom />} />
        <Route path="/trips/:tripId/analytics" element={<Analytics />} />
        <Route path="/admin" element={<Admin />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <I18nProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </I18nProvider>
  </StrictMode>,
);

registerServiceWorker();
