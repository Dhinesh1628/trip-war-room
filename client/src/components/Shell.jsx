import { Link, Outlet, useNavigate } from 'react-router-dom';
import { IconMap2, IconLogout, IconDatabase } from '@tabler/icons-react';
import { useAuth } from '../lib/auth.jsx';

export default function Shell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <header className="topnav">
        <Link to="/" className="brand">
          <IconMap2 size={20} stroke={1.6} aria-hidden="true" /> Trip War Room
        </Link>
        <nav className="row">
          {user?.role === 'admin' && (
            <Link to="/admin" className="btn ghost small">
              <IconDatabase size={16} aria-hidden="true" /> Datasets
            </Link>
          )}
          <span className="small muted">{user?.displayName}</span>
          <button
            className="ghost icon"
            aria-label="Sign out"
            title="Sign out"
            onClick={async () => {
              await logout();
              navigate('/signin');
            }}
          >
            <IconLogout size={18} aria-hidden="true" />
          </button>
        </nav>
      </header>
      <Outlet />
    </>
  );
}
