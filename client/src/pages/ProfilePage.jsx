import { useEffect, useState } from 'react';
import { get, patch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { initials, price } from '../lib/format.js';

const DIETARY = ['vegetarian', 'vegan', 'halal', 'kosher', 'gluten-free', 'dairy-free', 'nut-free'];

// Your needs (used by the Concierge and conflict checks in every trip) and
// the taste profile learned from what you pick.
export default function ProfilePage() {
  const { user } = useAuth();
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
          <div className="small muted">{user?.email}</div>
        </div>
      </div>
      {error && <div className="banner danger">{error}</div>}
      {dash && (
        <div className="stack">
          <Preferences profile={dash.preferenceProfile} onSaved={load} />
          <section className="panel">
            <h2>What you tend to pick</h2>
            <Profile history={dash.preferenceProfile.fromHistory} />
          </section>
        </div>
      )}
    </main>
  );
}

function Profile({ history }) {
  if (!history.signals) return <p className="small muted">Pin, vote on or save a few places and your taste profile appears here.</p>;
  const cur = history.priceRange?.currency;
  return (
    <div className="small stack">
      <div className="list-row"><span className="muted">Places you picked</span><span>{history.signals}</span></div>
      {history.favouriteCategories.length > 0 && (
        <div className="list-row"><span className="muted">Favourite kinds</span><span>{history.favouriteCategories.map((c) => c.name).join(', ')}</span></div>
      )}
      {history.priceRange && (
        <div className="list-row"><span className="muted">Usual price</span><span>{history.priceRange.min === history.priceRange.max ? price(history.priceRange.min, cur) : <>{price(history.priceRange.min, cur)} to {price(history.priceRange.max, cur)} (typical {price(history.priceRange.median, cur)})</>}</span></div>
      )}
      {history.dietaryTagsOfLikedPlaces.length > 0 && (
        <div className="list-row"><span className="muted">Often</span><span>{history.dietaryTagsOfLikedPlaces.map((c) => c.name).join(', ')}</span></div>
      )}
    </div>
  );
}

function Preferences({ profile, onSaved }) {
  const { setUser } = useAuth();
  const [tags, setTags] = useState(profile.declared.dietaryTags);
  const [ceiling, setCeiling] = useState(profile.declared.budgetCeiling ?? '');
  const [state, setState] = useState(null);
  const toggle = (t) => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);

  async function save(e) {
    e.preventDefault();
    if (ceiling !== '' && !(Number(ceiling) > 0)) return setState({ error: 'Enter an amount above ₹0, or leave it empty' });
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
      <h2>Your needs</h2>
      <p className="small muted">The Concierge and conflict checks use these in every trip you join.</p>
      <div className="chips wrap-chips" role="group" aria-label="Dietary needs" style={{ margin: '4px 0 14px' }}>
        {DIETARY.map((t) => (
          <button type="button" key={t} className={`chip ${tags.includes(t) ? 'on' : ''}`} aria-pressed={tags.includes(t)} onClick={() => { toggle(t); setState(null); }}>
            {t}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="ceiling">Most you want to spend on a trip, in rupees (optional)</label>
        <input id="ceiling" type="number" min="1" step="500" value={ceiling} onChange={(e) => { setCeiling(e.target.value); setState(null); }} placeholder="15000" />
      </div>
      {state?.error && <div className="error">{state.error}</div>}
      <div className="row"><button className="primary">Save</button>{state?.saved && <span className="small muted">Saved</span>}</div>
    </form>
  );
}
