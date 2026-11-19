import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { IconMapPin } from '@tabler/icons-react';
import Photo from '../components/Photo.jsx';

// Hawa Mahal, Jaipur (Wikimedia Commons). Shown before sign-in, so it can't
// come from the destinations API.
const HERO = {
  url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/41/East_facade_Hawa_Mahal_Jaipur_from_ground_level_%28July_2022%29_-_img_01.jpg/960px-East_facade_Hawa_Mahal_Jaipur_from_ground_level_%28July_2022%29_-_img_01.jpg',
  credit: 'Chainwit.',
  license: 'CC BY-SA 4.0',
  source: 'https://commons.wikimedia.org/wiki/File:East_facade_Hawa_Mahal_Jaipur_from_ground_level_(July_2022)_-_img_01.jpg',
};
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
    <main className="auth">
      <Photo image={HERO} alt="Hawa Mahal, Jaipur" className="auth-photo" eager>
        <div className="hero-shade" aria-hidden="true" />
        <div className="auth-photo-text">
          <div className="hero-place"><IconMapPin size={14} aria-hidden="true" /> Hawa Mahal, Jaipur</div>
          <p className="auth-tag">Plan India together. One live board for your group: places, budget in rupees, and a concierge that keeps to your rules.</p>
        </div>
      </Photo>
      <div className="auth-side">
      <div className="brand" style={{ marginBottom: 28 }}>
        <span className="brand-mark" aria-hidden="true"><IconMapPin size={16} stroke={2} /></span>
        <span>Trip War Room</span>
      </div>
      <div className="auth-form">
        <h1>{registering ? 'Create your account' : 'Welcome back'}</h1>
        <p className="muted small">{registering ? 'Plan trips across India with your group, live.' : 'Sign in to pick up where your group left off.'}</p>
        <form onSubmit={submit} noValidate>
          {registering && (
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input id="name" value={form.displayName} onChange={set('displayName')} placeholder="Priya Sharma" autoComplete="name" />
              {errors.displayName && <div className="error">{errors.displayName}</div>}
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={form.email} onChange={set('email')} placeholder="priya@example.com" autoComplete="email" />
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
          <button className="primary block" type="submit" disabled={busy}>
            {busy ? 'One moment…' : registering ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </div>
      <p className="small muted" style={{ marginTop: 16 }}>
        {registering ? (
          <>Have an account? <Link to="/signin" state={location.state}>Sign in</Link></>
        ) : (
          <>New here? <Link to="/register" state={location.state}>Create an account</Link></>
        )}
      </p>
      </div>
    </main>
  );
}
