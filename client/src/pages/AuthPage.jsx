import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { IconMapPin, IconEye, IconEyeOff, IconInbox } from '@tabler/icons-react';
import { useAuth } from '../lib/auth.jsx';
import { useI18n, LanguageSelect } from '../lib/i18n.jsx';
import Photo from '../components/Photo.jsx';
import GoogleButton from '../components/GoogleButton.jsx';

// Hawa Mahal, Jaipur. Shown before sign-in, so it is a fixed file rather
// than coming from the destinations API.
export const HERO = {
  url: '/photos/east-facade-hawa-mahal-jaipur-from-ground-level-july-2022-im-05ea86-1280.jpg',
  credit: 'Chainwit.',
  license: 'CC BY-SA 4.0',
  source: 'https://commons.wikimedia.org/wiki/File:East_facade_Hawa_Mahal_Jaipur_from_ground_level_(July_2022)_-_img_01.jpg',
};

// Sign in and create account. Email and password, phone with a one-time
// code, or Google (each shown only when the server offers it).
export default function AuthPage({ mode }) {
  const { user, ready, providers, loginWithGoogle } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [method, setMethod] = useState('email');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState(null);
  const back = location.state?.from || '/';
  const registering = mode === 'register';

  if (ready && user) return <Navigate to={back} replace />;
  const done = () => navigate(back, { replace: true });

  return (
    <main className="auth">
      <AuthPhoto />
      <div className="auth-side">
        <div className="between" style={{ marginBottom: 28 }}>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true"><IconMapPin size={16} stroke={2} /></span>
            <span>Trip War Room</span>
          </div>
          <LanguageSelect />
        </div>
        <div className="auth-form">
          <h1>{registering ? t('Create your account') : t('Welcome back')}</h1>
          <p className="muted small">{registering ? t('Plan trips across India with your group, live.') : t('Sign in to pick up where your group left off.')}</p>

          {providers.google && (
            <div style={{ margin: '14px 0 4px' }}>
              <GoogleButton
                clientId={providers.google.clientId}
                text={registering ? 'signup_with' : 'continue_with'}
                onCredential={(c) => loginWithGoogle(c, remember).then(done).catch((e) => setError(e.message))}
              />
            </div>
          )}

          {providers.phone && (
            <div className="tabs-line" role="tablist" aria-label={t('Sign-in method')}>
              <button role="tab" aria-selected={method === 'email'} className={method === 'email' ? 'on' : ''} onClick={() => { setMethod('email'); setError(null); }}>{t('Email')}</button>
              <button role="tab" aria-selected={method === 'phone'} className={method === 'phone' ? 'on' : ''} onClick={() => { setMethod('phone'); setError(null); }}>{t('Phone (OTP)')}</button>
            </div>
          )}
          {!providers.phone && providers.google && <div className="or-line"><span>{t('or with email')}</span></div>}

          {method === 'email' ? (
            <EmailForm registering={registering} remember={remember} onDone={done} />
          ) : (
            <PhoneForm remember={remember} onDone={done} />
          )}

          <label className="check-row">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>{t('Keep me signed in')}</span>
          </label>
          {error && <div className="banner danger" role="alert" style={{ marginTop: 10 }}>{error}</div>}

          <p className="small muted" style={{ marginTop: 16 }}>
            {registering ? (
              <>{t('Have an account?')} <Link to="/signin" state={location.state}>{t('Sign in')}</Link></>
            ) : (
              <>{t('New here?')} <Link to="/register" state={location.state}>{t('Create an account')}</Link></>
            )}
          </p>
          <p className="tiny faint">{t('By continuing you agree to the Terms and Privacy policy.')} <Link to="/privacy">{t('Privacy policy')}</Link></p>
          {providers.testInbox && (
            <p className="tiny"><Link to="/dev/inbox"><IconInbox size={13} aria-hidden="true" /> {t('Open the test inbox (local only)')}</Link></p>
          )}
        </div>
      </div>
    </main>
  );
}

export function AuthPhoto() {
  const { t } = useI18n();
  return (
    <Photo image={HERO} alt={t('Hawa Mahal, Jaipur')} className="auth-photo" eager>
      <div className="hero-shade" aria-hidden="true" />
      <div className="auth-photo-text">
        <div className="hero-place"><IconMapPin size={14} aria-hidden="true" /> {t('Hawa Mahal, Jaipur')}</div>
        <p className="auth-tag">{t('Plan India together. One live board for your group: places, budget in rupees, and a concierge that keeps to your rules.')}</p>
        <div className="auth-facts">
          <div><strong>5</strong><span>{t('cities')}</span></div>
          <div><strong>122</strong><span>{t('places')}</span></div>
          <div><strong>₹</strong><span>{t('exact splits')}</span></div>
        </div>
      </div>
    </Photo>
  );
}

export function PasswordInput({ id, value, onChange, autoComplete, invalid }) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  return (
    <div className="pw-wrap">
      <input id={id} type={show ? 'text' : 'password'} value={value} onChange={onChange} autoComplete={autoComplete} aria-invalid={invalid || undefined} />
      <button type="button" className="ghost icon pw-eye" onClick={() => setShow(!show)} aria-label={show ? t('Hide password') : t('Show password')} aria-pressed={show}>
        {show ? <IconEyeOff size={18} aria-hidden="true" /> : <IconEye size={18} aria-hidden="true" />}
      </button>
    </div>
  );
}

function EmailForm({ registering, remember, onDone }) {
  const { login, register } = useAuth();
  const { t } = useI18n();
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => {
    setForm({ ...form, [k]: e.target.value });
    setErrors({ ...errors, [k]: null, form: null });
  };

  async function submit(e) {
    e.preventDefault();
    const local = {};
    if (!/^\S+@\S+\.\S+$/.test(form.email)) local.email = t('Enter a valid email address');
    if (registering && form.password.length < 8) local.password = t('Use at least 8 characters');
    if (!registering && !form.password) local.password = t('Enter your password');
    if (registering && !form.displayName.trim()) local.displayName = t('Enter the name others will see');
    if (Object.keys(local).length) return setErrors(local);
    setBusy(true);
    try {
      if (registering) await register(form.email, form.password, form.displayName.trim(), remember);
      else await login(form.email, form.password, remember);
      onDone();
    } catch (err) {
      const fieldErrors = Object.fromEntries((err.details ?? []).map((d) => [d.path, d.message]));
      setErrors({ ...fieldErrors, form: Object.keys(fieldErrors).length ? null : err.message });
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate style={{ marginTop: 12 }}>
      {registering && (
        <div className="field">
          <label htmlFor="name">{t('Your name')}</label>
          <input id="name" value={form.displayName} onChange={set('displayName')} placeholder="Priya Sharma" autoComplete="name" aria-invalid={Boolean(errors.displayName) || undefined} />
          {errors.displayName && <div className="error">{errors.displayName}</div>}
        </div>
      )}
      <div className="field">
        <label htmlFor="email">{t('Email')}</label>
        <input id="email" type="email" value={form.email} onChange={set('email')} placeholder="priya@example.com" autoComplete="email" aria-invalid={Boolean(errors.email) || undefined} />
        {errors.email && <div className="error">{errors.email}</div>}
      </div>
      <div className="field">
        <div className="between">
          <label htmlFor="password">{t('Password')}</label>
          {!registering && <Link to="/forgot-password" className="small">{t('Forgot password?')}</Link>}
        </div>
        <PasswordInput id="password" value={form.password} onChange={set('password')} autoComplete={registering ? 'new-password' : 'current-password'} invalid={Boolean(errors.password)} />
        {errors.password && <div className="error">{errors.password}</div>}
      </div>
      {errors.form && <div className="banner danger" role="alert" style={{ marginBottom: 12 }}>{errors.form}</div>}
      <button className="primary block" type="submit" disabled={busy}>
        {busy ? t('One moment…') : registering ? t('Create account') : t('Sign in')}
      </button>
    </form>
  );
}

function PhoneForm({ remember, onDone }) {
  const { requestCode, verifyCode } = useAuth();
  const { t } = useI18n();
  const [step, setStep] = useState('phone'); // phone -> code -> name
  const [phone, setPhone] = useState('');
  const [normalised, setNormalised] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);

  const fail = (err) => {
    setError(err.details?.[0]?.message ?? err.message);
    setBusy(false);
  };

  async function send(e) {
    e?.preventDefault();
    if (phone.replace(/\D/g, '').length < 10) return setError(t('Enter a mobile number, like 98765 43210'));
    setBusy(true);
    setError(null);
    try {
      const r = await requestCode(phone);
      setNormalised(r.phone);
      setStep('code');
      setInfo(t('We sent a 6-digit code to {phone}. It expires in 5 minutes.', { phone: r.phone }));
      setBusy(false);
    } catch (err) {
      fail(err);
    }
  }

  async function verify(e) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError(t('Enter the 6-digit code'));
    if (step === 'name' && !name.trim()) return setError(t('Enter the name others will see'));
    setBusy(true);
    setError(null);
    try {
      const r = await verifyCode(normalised, code, step === 'name' ? name.trim() : undefined, remember);
      if (r?.needsName) {
        setStep('name');
        setInfo(t("You're new here. What should your group call you?"));
        setBusy(false);
        return;
      }
      onDone();
    } catch (err) {
      fail(err);
    }
  }

  if (step === 'phone') {
    return (
      <form onSubmit={send} noValidate style={{ marginTop: 12 }}>
        <div className="field">
          <label htmlFor="phone">{t('Mobile number')}</label>
          <div className="phone-wrap">
            <span className="muted" aria-hidden="true">+91</span>
            <input id="phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setError(null); }} placeholder="98765 43210" aria-describedby="phone-hint" />
          </div>
          <div id="phone-hint" className="tiny muted" style={{ marginTop: 4 }}>{t('Outside India? Start with your country code, like +44.')}</div>
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="primary block" disabled={busy}>{busy ? t('Sending…') : t('Send code')}</button>
      </form>
    );
  }
  return (
    <form onSubmit={verify} noValidate style={{ marginTop: 12 }}>
      {info && <p className="small muted" role="status">{info}</p>}
      <div className="field">
        <label htmlFor="otp">{t('6-digit code')}</label>
        <input id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setError(null); }} className="otp-input" />
      </div>
      {step === 'name' && (
        <div className="field">
          <label htmlFor="otp-name">{t('Your name')}</label>
          <input id="otp-name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} autoComplete="name" placeholder="Ravi Kumar" />
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <button className="primary block" disabled={busy}>{busy ? t('Checking…') : step === 'name' ? t('Create account') : t('Verify and sign in')}</button>
      <div className="between small" style={{ marginTop: 8 }}>
        <button type="button" className="ghost small" onClick={() => { setStep('phone'); setCode(''); setInfo(null); }}>{t('Change number')}</button>
        <button type="button" className="ghost small" disabled={busy} onClick={send}>{t('Send a new code')}</button>
      </div>
    </form>
  );
}
