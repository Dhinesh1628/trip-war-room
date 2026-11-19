import { useState } from 'react';
import { Link } from 'react-router-dom';
import { IconCircleCheck, IconAlertCircle, IconBrandGoogle, IconPhone, IconMail } from '@tabler/icons-react';
import { post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { PasswordInput } from './AuthPage.jsx';

// Account and security: sign-in methods, email confirmation, password, and
// signing out other devices.
export default function AccountPage() {
  const { user, setUser } = useAuth();
  const { t } = useI18n();
  if (!user) return <main className="page muted">{t('Loading…')}</main>;
  return (
    <main className="page narrow-page">
      <h1>{t('Account and security')}</h1>
      <p className="small muted">{t('Manage how you sign in.')} <Link to="/profile">{t('Your needs and taste')}</Link></p>
      <div className="stack" style={{ marginTop: 16 }}>
        <section className="panel" aria-label={t('Sign-in methods')}>
          <h2>{t('Sign-in methods')}</h2>
          <div className="list-row">
            <span><IconMail size={16} aria-hidden="true" /> {t('Email')}</span>
            <span>{user.email ?? t('Not added')}</span>
          </div>
          {user.email && <EmailStatus user={user} />}
          <div className="list-row">
            <span><IconPhone size={16} aria-hidden="true" /> {t('Phone')}</span>
            <span>{user.phone ?? t('Not added')}</span>
          </div>
          <div className="list-row">
            <span><IconBrandGoogle size={16} aria-hidden="true" /> Google</span>
            <span>{user.googleLinked ? t('Linked') : t('Not linked')}</span>
          </div>
        </section>
        <PasswordForm user={user} onChanged={setUser} />
        <Sessions />
      </div>
    </main>
  );
}

function EmailStatus({ user }) {
  const { t } = useI18n();
  const [state, setState] = useState(null);
  if (user.emailVerified) return <p className="small" style={{ color: 'var(--ok)' }}><IconCircleCheck size={14} aria-hidden="true" /> {t('Email confirmed')}</p>;
  return (
    <div className="banner warn" style={{ margin: '6px 0' }}>
      <IconAlertCircle size={16} aria-hidden="true" style={{ flex: 'none' }} />
      <span className="grow">{t('Your email is not confirmed yet. Confirming it lets you reset your password and get trip invites.')}</span>
      <button
        className="small"
        disabled={state?.busy}
        onClick={async () => {
          setState({ busy: true });
          try {
            const r = await post('/auth/email/resend');
            setState({ msg: r.message });
          } catch (err) {
            setState({ msg: err.message });
          }
        }}
      >
        {t('Send link')}
      </button>
      {state?.msg && <span className="small" role="status">{state.msg}</span>}
    </div>
  );
}

function PasswordForm({ user, onChanged }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [state, setState] = useState(null);
  async function submit(e) {
    e.preventDefault();
    if (user.passwordSet && !current) return setState({ error: t('Enter your current password') });
    if (next.length < 8) return setState({ error: t('Use at least 8 characters') });
    setState({ busy: true });
    try {
      const r = await post('/auth/password/change', { ...(user.passwordSet ? { currentPassword: current } : {}), newPassword: next });
      onChanged(r.user);
      setCurrent('');
      setNext('');
      setState({ ok: t('Password saved. {n} other sessions were signed out.', { n: r.signedOutSessions }) });
    } catch (err) {
      setState({ error: err.details?.[0]?.message ?? err.message });
    }
  }
  return (
    <form className="panel" onSubmit={submit} noValidate>
      <h2>{user.passwordSet ? t('Change password') : t('Set a password')}</h2>
      {!user.passwordSet && <p className="small muted">{t('You sign in with Google or a phone code. Add a password to also sign in with your email.')}</p>}
      {user.passwordSet && (
        <div className="field">
          <label htmlFor="cur-pw">{t('Current password')}</label>
          <PasswordInput id="cur-pw" value={current} onChange={(e) => { setCurrent(e.target.value); setState(null); }} autoComplete="current-password" />
          <Link to="/forgot-password" className="small">{t('Forgot password?')}</Link>
        </div>
      )}
      <div className="field">
        <label htmlFor="new-pw">{t('New password')}</label>
        <PasswordInput id="new-pw" value={next} onChange={(e) => { setNext(e.target.value); setState(null); }} autoComplete="new-password" />
        <div className="tiny muted" style={{ marginTop: 4 }}>{t('At least 8 characters.')}</div>
      </div>
      {state?.error && <div className="error" role="alert">{state.error}</div>}
      {state?.ok && <div className="small" role="status" style={{ color: 'var(--ok)' }}>{state.ok}</div>}
      <button className="primary" disabled={state?.busy}>{t('Save password')}</button>
    </form>
  );
}

function Sessions() {
  const { t } = useI18n();
  const [state, setState] = useState(null);
  return (
    <section className="panel">
      <h2>{t('Devices')}</h2>
      <p className="small muted">{t('Lost a phone or used a shared computer? Sign out everywhere except here.')}</p>
      <button
        disabled={state?.busy}
        onClick={async () => {
          setState({ busy: true });
          try {
            const r = await post('/auth/sessions/revoke-others');
            setState({ ok: t('Signed out of {n} other sessions.', { n: r.signedOutSessions }) });
          } catch (err) {
            setState({ error: err.message });
          }
        }}
      >
        {t('Sign out other devices')}
      </button>
      {state?.ok && <div className="small" role="status" style={{ marginTop: 6 }}>{state.ok}</div>}
      {state?.error && <div className="error" role="alert">{state.error}</div>}
    </section>
  );
}
