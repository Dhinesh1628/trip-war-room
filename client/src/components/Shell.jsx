import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { IconMapPin, IconLogout, IconDatabase, IconCompass, IconLuggage, IconHeart, IconUser, IconTicket, IconX } from '@tabler/icons-react';
import { useAuth } from '../lib/auth.jsx';
import { initials } from '../lib/format.js';

// App frame: top bar (brand, sections, join with code, account menu) and,
// on phones, a bottom menu like a native app.
export default function Shell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menu, setMenu] = useState(false);
  const [joining, setJoining] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => setMenu(false), [location.pathname]);
  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => !menuRef.current?.contains(e.target) && setMenu(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const inRoom = /^\/trips\/[^/]+/.test(location.pathname);
  return (
    <>
      <header className="topnav">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true"><IconMapPin size={16} stroke={2} /></span>
          <span>Trip War Room</span>
        </Link>
        <nav className="top-links" aria-label="Sections">
          <NavLink to="/" end>Explore</NavLink>
          <NavLink to="/trips" end>Trips</NavLink>
          <NavLink to="/saved">Saved</NavLink>
        </nav>
        <div className="row">
          <button className="pill-btn hide-phone" onClick={() => setJoining(true)}>
            <IconTicket size={16} aria-hidden="true" /> Join with code
          </button>
          <div className="menu-wrap" ref={menuRef}>
            <button className="account-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} aria-label="Account menu">
              <span className="avatar">{initials(user?.displayName)}</span>
            </button>
            {menu && (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <div style={{ fontWeight: 500 }}>{user?.displayName}</div>
                  <div className="tiny muted">{user?.email}</div>
                </div>
                <Link role="menuitem" to="/profile"><IconUser size={16} aria-hidden="true" /> Your needs and taste</Link>
                <Link role="menuitem" to="/saved"><IconHeart size={16} aria-hidden="true" /> Saved places</Link>
                <button role="menuitem" className="show-phone-only" onClick={() => { setMenu(false); setJoining(true); }}>
                  <IconTicket size={16} aria-hidden="true" /> Join with code
                </button>
                {user?.role === 'admin' && <Link role="menuitem" to="/admin"><IconDatabase size={16} aria-hidden="true" /> Datasets</Link>}
                <button
                  role="menuitem"
                  onClick={async () => {
                    await logout();
                    navigate('/signin');
                  }}
                >
                  <IconLogout size={16} aria-hidden="true" /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <Outlet />

      {!inRoom && (
        <nav className="bottom-nav" aria-label="Sections">
          <NavLink to="/" end><IconCompass size={22} stroke={1.6} aria-hidden="true" /><span>Explore</span></NavLink>
          <NavLink to="/trips" end><IconLuggage size={22} stroke={1.6} aria-hidden="true" /><span>Trips</span></NavLink>
          <NavLink to="/saved"><IconHeart size={22} stroke={1.6} aria-hidden="true" /><span>Saved</span></NavLink>
          <NavLink to="/profile"><IconUser size={22} stroke={1.6} aria-hidden="true" /><span>Profile</span></NavLink>
        </nav>
      )}

      {joining && <JoinDialog onClose={() => setJoining(false)} />}
    </>
  );
}

export function JoinDialog({ onClose }) {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  return (
    <div className="dim" onClick={onClose}>
      <form
        className="dialog"
        style={{ maxWidth: 400 }}
        role="dialog"
        aria-modal="true"
        aria-label="Join a trip"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          const clean = code.replace(/[^a-z0-9]/gi, '');
          if (clean.length !== 6) return setError('Invite codes have 6 letters and numbers, like AB-7Q2K');
          onClose();
          navigate(`/join/${clean.toUpperCase()}`);
        }}
        noValidate
      >
        <div className="between">
          <h2 style={{ margin: 0 }}>Join a trip</h2>
          <button type="button" className="round-btn" onClick={onClose} aria-label="Close"><IconX size={18} aria-hidden="true" /></button>
        </div>
        <p className="small muted">Got an invite code from the trip leader? Enter it here.</p>
        <div className="field">
          <label htmlFor="join-code">Invite code</label>
          <input id="join-code" autoFocus value={code} onChange={(e) => { setCode(e.target.value); setError(null); }} placeholder="AB-7Q2K" autoCapitalize="characters" />
          {error && <div className="error">{error}</div>}
        </div>
        <button className="primary block">Find trip</button>
      </form>
    </div>
  );
}
