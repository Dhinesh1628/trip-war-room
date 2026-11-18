import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { IconMap2 } from '@tabler/icons-react';
import { useAuth } from '../lib/auth.jsx';

export default function AuthPage({ mode }) {
  const { user, ready, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const back = location.state?.from || '/';
  const registering = mode === 'register';

  if (ready && user) return <Navigate to={back} replace />;

  const set = (k) => (e) => {
    setForm({ ...form, [k]: e.target.value });
    setErrors({ ...errors, [k]: null, form: null });
  };

  async function submit(e) {
    e.preventDefault();
    const local = {};
    if (!/^\S+@\S+\.\S+$/.test(form.email)) local.email = 'Enter a valid email address';
    if (registering && form.password.length < 8) local.password = 'Use at least 8 characters';
    if (!registering && !form.password) local.password = 'Enter your password';
    if (registering && !form.displayName.trim()) local.displayName = 'Enter the name others will see';
    if (Object.keys(local).length) return setErrors(local);

    setBusy(true);
    try {
      if (registering) await register(form.email, form.password, form.displayName.trim());
      else await login(form.email, form.password);
      navigate(back, { replace: true });
    } catch (err) {
      const fieldErrors = Object.fromEntries((err.details ?? []).map((d) => [d.path, d.message]));
      setErrors({ ...fieldErrors, form: Object.keys(fieldErrors).length ? null : err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <div className="row" style={{ marginBottom: 20 }}>
        <IconMap2 size={24} stroke={1.6} aria-hidden="true" />
        <span style={{ fontWeight: 500, fontSize: 16 }}>Trip War Room</span>
      </div>
      <div className="panel" style={{ padding: 20 }}>
        <h1>{registering ? 'Create your account' : 'Sign in'}</h1>
        <p className="muted small">{registering ? 'Plan trips with your group, live.' : 'Welcome back.'}</p>
        <form onSubmit={submit} noValidate>
          {registering && (
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input id="name" value={form.displayName} onChange={set('displayName')} placeholder="Maya Costa" autoComplete="name" />
              {errors.displayName && <div className="error">{errors.displayName}</div>}
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={form.email} onChange={set('email')} placeholder="maya@example.com" autoComplete="email" />
            {errors.email && <div className="error">{errors.email}</div>}
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={form.password}
              onChange={set('password')}
              autoComplete={registering ? 'new-password' : 'current-password'}
            />
            {errors.password && <div className="error">{errors.password}</div>}
          </div>
          {errors.form && <div className="banner danger" role="alert" style={{ marginBottom: 12 }}>{errors.form}</div>}
          <button className="primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? 'One moment…' : registering ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </div>
      <p className="small muted" style={{ marginTop: 12, textAlign: 'center' }}>
        {registering ? (
          <>Have an account? <Link to="/signin" state={location.state}>Sign in</Link></>
        ) : (
          <>New here? <Link to="/register" state={location.state}>Create an account</Link></>
        )}
      </p>
    </main>
  );
}
