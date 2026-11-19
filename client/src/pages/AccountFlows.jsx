import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconMapPin, IconCircleCheck, IconRefresh } from '@tabler/icons-react';
import { api, get, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useI18n, LanguageSelect } from '../lib/i18n.jsx';
import { AuthPhoto, PasswordInput } from './AuthPage.jsx';

function AuthShell({ title, children }) {
  return (
    <main className="auth">
      <AuthPhoto />
      <div className="auth-side">
        <div className="between" style={{ marginBottom: 28 }}>
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden="true"><IconMapPin size={16} stroke={2} /></span>
            <span>Trip War Room</span>
          </Link>
          <LanguageSelect />
        </div>
        <div className="auth-form">
          <h1>{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}

// "Forgot password?": ask for a reset link by email.
export function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [state, setState] = useState(null);
  async function submit(e) {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email)) return setState({ error: t('Enter a valid email address') });
    setState({ busy: true });
    try {
      await post('/auth/password/forgot', { email });
      setState({ sent: true });
    } catch (err) {
      setState({ error: err.message });
    }
  }
  return (
    <AuthShell title={t('Reset your password')}>
      {state?.sent ? (
        <div role="status">
          <p><IconCircleCheck size={18} aria-hidden="true" /> {t('If an account uses {email}, a reset link is on its way. It works once, for 30 minutes.', { email })}</p>
          <p className="small muted">{t("Didn't get it? Check spam, or try again in a minute.")}</p>
          <Link to="/signin" className="btn">{t('Back to sign in')}</Link>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <p className="small muted">{t("Enter your account's email and we'll send you a link to set a new password.")}</p>
          <div className="field">
            <label htmlFor="fp-email">{t('Email')}</label>
            <input id="fp-email" type="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); setState(null); }} placeholder="priya@example.com" />
          </div>
          {state?.error && <div className="banner danger" role="alert" style={{ marginBottom: 12 }}>{state.error}</div>}
          <button className="primary block" disabled={state?.busy}>{state?.busy ? t('Sending…') : t('Send reset link')}</button>
          <p className="small" style={{ marginTop: 14 }}><Link to="/signin">{t('Back to sign in')}</Link></p>
        </form>
      )}
    </AuthShell>
  );
}

// The link from the reset email: choose a new password.
export function ResetPasswordPage() {
  const { t } = useI18n();
  const { resetPassword } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [state, setState] = useState(null);
  async function submit(e) {
    e.preventDefault();
    if (pw.length < 8) return setState({ error: t('Use at least 8 characters') });
    if (pw !== pw2) return setState({ error: t("The two passwords don't match") });
    setState({ busy: true });
    try {
      await resetPassword(token, pw);
      navigate('/', { replace: true });
    } catch (err) {
      setState({ error: err.details?.[0]?.message ?? err.message });
    }
  }
  return (
    <AuthShell title={t('Choose a new password')}>
      {!token ? (
        <p>{t('This link is incomplete.')} <Link to="/forgot-password">{t('Ask for a new reset link')}</Link></p>
      ) : (
        <form onSubmit={submit} noValidate>
          <p className="small muted">{t("You'll be signed out on your other devices.")}</p>
          <div className="field">
            <label htmlFor="np1">{t('New password')}</label>
            <PasswordInput id="np1" value={pw} onChange={(e) => { setPw(e.target.value); setState(null); }} autoComplete="new-password" />
          </div>
          <div className="field">
            <label htmlFor="np2">{t('Type it again')}</label>
            <PasswordInput id="np2" value={pw2} onChange={(e) => { setPw2(e.target.value); setState(null); }} autoComplete="new-password" />
          </div>
          {state?.error && (
            <div className="banner danger" role="alert" style={{ marginBottom: 12 }}>
              {state.error} {/expired|used/.test(state.error) && <Link to="/forgot-password">{t('Ask for a new reset link')}</Link>}
            </div>
          )}
          <button className="primary block" disabled={state?.busy}>{state?.busy ? t('Saving…') : t('Set password and sign in')}</button>
        </form>
      )}
    </AuthShell>
  );
}

// The link from the "confirm your email" message.
export function VerifyEmailPage() {
  const { t } = useI18n();
  const { setUser, user } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState({ busy: true });
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return; // the link is single-use: don't send it twice
    ran.current = true;
    if (!token) return setState({ error: t('This link is incomplete.') });
    post('/auth/email/verify', { token })
      .then((r) => {
        if (user && r.user.id === user.id) setUser(r.user);
        setState({ ok: true });
      })
      .catch((err) => setState({ error: err.message }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AuthShell title={t('Confirm your email')}>
      {state.busy && <p className="muted" role="status">{t('Checking your link…')}</p>}
      {state.ok && (
        <div role="status">
          <p><IconCircleCheck size={18} aria-hidden="true" /> {t('Your email is confirmed. Thank you.')}</p>
          <Link to="/" className="btn primary">{t('Go to your dashboard')}</Link>
        </div>
      )}
      {state.error && (
        <div>
          <div className="banner danger" role="alert">{state.error}</div>
          <p className="small" style={{ marginTop: 12 }}><Link to="/account">{t('Send a new link from your account page')}</Link></p>
        </div>
      )}
    </AuthShell>
  );
}

export function PrivacyPage() {
  const { t } = useI18n();
  return (
    <main className="page narrow-page">
      <p><Link to="/">{t('Back')}</Link></p>
      <h1>{t('Privacy policy')}</h1>
      <div className="stack small">
        <p>{t('Trip War Room stores what it needs to run your trips: your name, your email or phone number, a hash of your password (never the password), your dietary needs and budget, the trips you join, what you pin, vote on, chat and review, and places you save.')}</p>
        <p>{t('Your group can see your name, what you add to the board, your chat messages and your reviews. Your email, phone number and password are never shown to others.')}</p>
        <p>{t('Sign-in codes and reset links are stored only as hashes and expire. Sessions use a secure cookie; you can sign out of other devices from your account page.')}</p>
        <p>{t('Photos are from Wikimedia Commons, credited on each picture. Maps use OpenStreetMap. If Google sign-in is used, Google tells us your name and email.')}</p>
        <p>{t('This is a student project prototype. Ask the site owner to delete your account and data.')}</p>
      </div>
    </main>
  );
}

// Local development only: the emails and texts the server would have sent.
export function TestInboxPage() {
  const { t } = useI18n();
  const [msgs, setMsgs] = useState(null);
  const [error, setError] = useState(null);
  const load = () => get('/dev/outbox').then((r) => setMsgs(r.messages)).catch((e) => setError(e.status === 404 ? t('The test inbox only exists on a local development server.') : e.message));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const linkify = (text) =>
    text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
      /^https?:\/\//.test(part) ? <a key={i} href={part.replace(/^https?:\/\/[^/]+/, '')}>{part}</a> : <span key={i}>{part}</span>,
    );
  return (
    <main className="page narrow-page">
      <div className="section-head">
        <h1>{t('Test inbox')}</h1>
        <div className="row">
          <button className="pill-btn" onClick={load}><IconRefresh size={16} aria-hidden="true" /> {t('Refresh')}</button>
          <button className="pill-btn" onClick={() => api('DELETE', '/dev/outbox').then(load)}>{t('Empty')}</button>
        </div>
      </div>
      <p className="small muted">{t('Emails and text messages this local server would have sent. Real sending starts when the email and SMS keys are set.')}</p>
      {error && <div className="banner danger">{error}</div>}
      {msgs?.length === 0 && <div className="empty"><p className="muted">{t('Nothing yet. Sign up, ask for a code or reset a password.')}</p></div>}
      <div className="stack">
        {msgs?.map((m, i) => (
          <article key={i} className="panel">
            <div className="between small"><strong>{m.kind === 'sms' ? t('Text to {to}', { to: m.to }) : t('Email to {to}', { to: m.to })}</strong><span className="muted">{new Date(m.sentAt).toLocaleTimeString()}</span></div>
            {m.subject && <div className="small" style={{ fontWeight: 500, marginTop: 4 }}>{m.subject}</div>}
            <p className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{linkify(m.text)}</p>
          </article>
        ))}
      </div>
    </main>
  );
}
