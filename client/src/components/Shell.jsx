import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { IconMapPin, IconLogout, IconDatabase, IconCompass, IconLuggage, IconHeart, IconUser, IconTicket, IconX, IconHome, IconShieldLock, IconInbox } from '@tabler/icons-react';
import { useAuth } from '../lib/auth.jsx';
import { useI18n, LanguageSelect } from '../lib/i18n.jsx';
import { initials } from '../lib/format.js';
import InstallBanner from './InstallBanner.jsx';

// App frame: top bar (brand, sections, join with code, account menu) and,
// on phones, a bottom menu like a native app.
export default function Shell() {
  const { user, logout, providers } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [menu, setMenu] = useState(false);
  const [joining, setJoining] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => setMenu(false), [location.pathname]);
  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => !menuRef.current?.contains(e.target) && setMenu(false);
    const esc = (e) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menu]);

  const inRoom = /^\/trips\/[^/]+/.test(location.pathname);
  return (
    <>
      <a className="skip-link" href="#main">{t('Skip to content')}</a>
      <header className="topnav">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true"><IconMapPin size={16} stroke={2} /></span>
          <span>Trip War Room</span>
        </Link>
        <nav className="top-links" aria-label={t('Sections')}>
          <NavLink to="/" end>{t('Home')}</NavLink>
          <NavLink to="/explore">{t('Explore')}</NavLink>
          <NavLink to="/trips" end>{t('Trips')}</NavLink>
          <NavLink to="/saved">{t('Saved')}</NavLink>
        </nav>
        <div className="row">
          <button className="pill-btn hide-phone" onClick={() => setJoining(true)}>
            <IconTicket size={16} aria-hidden="true" /> {t('Join with code')}
          </button>
          <div className="menu-wrap" ref={menuRef}>
            <button className="account-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} aria-label={t('Account menu')}>
              <span className="avatar">{initials(user?.displayName)}</span>
            </button>
            {menu && (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <div style={{ fontWeight: 500 }}>{user?.displayName}</div>
                  <div className="tiny muted">{user?.email ?? user?.phone}</div>
                </div>
                <Link role="menuitem" to="/profile"><IconUser size={16} aria-hidden="true" /> {t('Your needs and taste')}</Link>
                <Link role="menuitem" to="/account"><IconShieldLock size={16} aria-hidden="true" /> {t('Account and security')}</Link>
                <Link role="menuitem" to="/saved"><IconHeart size={16} aria-hidden="true" /> {t('Saved places')}</Link>
                <button role="menuitem" className="show-phone-only" onClick={() => { setMenu(false); setJoining(true); }}>
                  <IconTicket size={16} aria-hidden="true" /> {t('Join with code')}
                </button>
                {user?.role === 'admin' && <Link role="menuitem" to="/admin"><IconDatabase size={16} aria-hidden="true" /> {t('Datasets')}</Link>}
                {providers.testInbox && <Link role="menuitem" to="/dev/inbox"><IconInbox size={16} aria-hidden="true" /> {t('Test inbox')}</Link>}
                <div className="menu-lang"><LanguageSelect /></div>
                <button
                  role="menuitem"
                  onClick={async () => {
                    await logout();
                    navigate('/signin');
                  }}
                >
                  <IconLogout size={16} aria-hidden="true" /> {t('Sign out')}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div id="main">
        <Outlet />
      </div>
      <InstallBanner />

      {!inRoom && (
        <nav className="bottom-nav" aria-label={t('Sections')}>
          <NavLink to="/" end><IconHome size={22} stroke={1.6} aria-hidden="true" /><span>{t('Home')}</span></NavLink>
          <NavLink to="/explore"><IconCompass size={22} stroke={1.6} aria-hidden="true" /><span>{t('Explore')}</span></NavLink>
          <NavLink to="/trips" end><IconLuggage size={22} stroke={1.6} aria-hidden="true" /><span>{t('Trips')}</span></NavLink>
          <NavLink to="/saved"><IconHeart size={22} stroke={1.6} aria-hidden="true" /><span>{t('Saved')}</span></NavLink>
          <NavLink to="/profile"><IconUser size={22} stroke={1.6} aria-hidden="true" /><span>{t('Profile')}</span></NavLink>
        </nav>
      )}

      {joining && <JoinDialog onClose={() => setJoining(false)} />}
    </>
  );
}

export function JoinDialog({ onClose }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="dim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog"
        style={{ maxWidth: 400 }}
        role="dialog"
        aria-modal="true"
        aria-label={t('Join a trip')}
        onSubmit={(e) => {
          e.preventDefault();
          const clean = code.replace(/[^a-z0-9]/gi, '');
          if (clean.length !== 6) return setError(t('Invite codes have 6 letters and numbers, like AB-7Q2K'));
          onClose();
          navigate(`/join/${clean.toUpperCase()}`);
        }}
        noValidate
      >
        <div className="between">
          <h2 style={{ margin: 0 }}>{t('Join a trip')}</h2>
          <button type="button" className="round-btn" onClick={onClose} aria-label={t('Close')}><IconX size={18} aria-hidden="true" /></button>
        </div>
        <p className="small muted">{t('Got an invite code from the trip leader? Enter it here.')}</p>
        <div className="field">
          <label htmlFor="join-code">{t('Invite code')}</label>
          <input id="join-code" autoFocus value={code} onChange={(e) => { setCode(e.target.value); setError(null); }} placeholder="AB-7Q2K" autoCapitalize="characters" />
          {error && <div className="error">{error}</div>}
        </div>
        <button className="primary block">{t('Find trip')}</button>
      </form>
    </div>
  );
}
