import { useEffect, useState } from 'react';
import { get, patch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Link } from 'react-router-dom';
import { initials, price } from '../lib/format.js';
import { useI18n } from '../lib/i18n.jsx';

const DIETARY = ['vegetarian', 'vegan', 'halal', 'kosher', 'gluten-free', 'dairy-free', 'nut-free'];

// Your needs (used by the Concierge and conflict checks in every trip) and
// the taste profile learned from what you pick.
export default function ProfilePage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [dash, setDash] = useState(null);
  const [error, setError] = useState(null);
  const load = () => get('/users/me/dashboard').then(setDash).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  return (
    <main className="page narrow-page">
      <div className="row" style={{ gap: 14, marginBottom: 20 }}>
        <span className="avatar avatar-lg">{initials(user?.displayName)}</span>
        <div>
          <h1 style={{ margin: 0 }}>{user?.displayName}</h1>
          <div className="small muted">{user?.email ?? user?.phone}</div>
          <Link to="/account" className="small">{t('Account and security')}</Link>
        </div>
      </div>
      {error && <div className="banner danger">{error}</div>}
      {dash && (
        <div className="stack">
          <Preferences profile={dash.preferenceProfile} onSaved={load} />
          <section className="panel">
            <h2>{t('What you tend to pick')}</h2>
            <Profile history={dash.preferenceProfile.fromHistory} />
          </section>
        </div>
      )}
    </main>
  );
}

function Profile({ history }) {
  const { t } = useI18n();
  if (!history.signals) return <p className="small muted">{t('Pin, vote on or save a few places and your taste profile appears here.')}</p>;
  const cur = history.priceRange?.currency;
  return (
    <div className="small stack">
      <div className="list-row"><span className="muted">{t('Places you picked')}</span><span>{history.signals}</span></div>
      {history.favouriteCategories.length > 0 && (
        <div className="list-row"><span className="muted">{t('Favourite kinds')}</span><span>{history.favouriteCategories.map((c) => t(c.name)).join(', ')}</span></div>
      )}
      {history.priceRange && (
        <div className="list-row"><span className="muted">{t('Usual price')}</span><span>{history.priceRange.min === history.priceRange.max ? price(history.priceRange.min, cur) : <>{t('{min} to {max} (typical {median})', { min: price(history.priceRange.min, cur), max: price(history.priceRange.max, cur), median: price(history.priceRange.median, cur) })}</>}</span></div>
      )}
      {history.dietaryTagsOfLikedPlaces.length > 0 && (
        <div className="list-row"><span className="muted">{t('Often')}</span><span>{history.dietaryTagsOfLikedPlaces.map((c) => t(c.name)).join(', ')}</span></div>
      )}
    </div>
  );
}

function Preferences({ profile, onSaved }) {
  const { setUser } = useAuth();
  const { t } = useI18n();
  const [tags, setTags] = useState(profile.declared.dietaryTags);
  const [ceiling, setCeiling] = useState(profile.declared.budgetCeiling ?? '');
  const [state, setState] = useState(null);
  const toggle = (t) => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);

  async function save(e) {
    e.preventDefault();
    if (ceiling !== '' && !(Number(ceiling) > 0)) return setState({ error: t('Enter an amount above ₹0, or leave it empty') });
    try {
      const r = await patch('/users/me', { preferences: { dietaryTags: tags, budgetCeiling: ceiling === '' ? null : Number(ceiling) } });
      setUser(r.user);
      setState({ saved: true });
      onSaved();
    } catch (err) {
      setState({ error: err.message });
    }
  }

  return (
    <form className="panel" onSubmit={save} noValidate>
      <h2>{t('Your needs')}</h2>
      <p className="small muted">{t('The Concierge and conflict checks use these in every trip you join.')}</p>
      <div className="chips wrap-chips" role="group" aria-label={t('Dietary needs')} style={{ margin: '4px 0 14px' }}>
        {DIETARY.map((d) => (
          <button type="button" key={d} className={`chip ${tags.includes(d) ? 'on' : ''}`} aria-pressed={tags.includes(d)} onClick={() => { toggle(d); setState(null); }}>
            {t(d)}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="ceiling">{t('Most you want to spend on a trip, in rupees (optional)')}</label>
        <input id="ceiling" type="number" min="1" step="500" value={ceiling} onChange={(e) => { setCeiling(e.target.value); setState(null); }} placeholder="15000" />
      </div>
      {state?.error && <div className="error">{state.error}</div>}
      <div className="row"><button className="primary">{t('Save')}</button>{state?.saved && <span className="small muted" role="status">{t('Saved')}</span>}</div>
    </form>
  );
}
