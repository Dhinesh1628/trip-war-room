import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { IconUsers, IconArrowRight, IconChartBar } from '@tabler/icons-react';
import { get, post, patch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { dateRange, price } from '../lib/format.js';

const DIETARY = ['vegetarian', 'vegan', 'halal', 'kosher', 'gluten-free', 'dairy-free', 'nut-free'];

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = () => get('/users/me/dashboard').then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  if (error) return <main className="page"><div className="banner danger">{error}</div></main>;
  if (!data) return <main className="page muted">Loading your trips…</main>;

  const trips = [...data.trips.led, ...data.trips.joined];
  return (
    <main className="page stack">
      <h1>Your trips</h1>
      {data.activeRooms.length > 0 && (
        <div className="banner info">
          <IconUsers size={16} aria-hidden="true" />
          <span>
            Planning now: {data.activeRooms.map((t, i) => (
              <span key={t.tripId}>{i > 0 && ', '}<Link to={`/trips/${t.tripId}`}>{t.destination}</Link> ({t.onlineNow} online)</span>
            ))}
          </span>
        </div>
      )}

      <section className="grid-cards">
        {trips.map((t) => (
          <Link key={t.tripId} to={`/trips/${t.tripId}`} className="panel" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="between">
              <h3 style={{ margin: 0 }}>{t.destination}</h3>
              <span className="tag">{t.myRole}</span>
            </div>
            <div className="small muted">{dateRange(t.startDate, t.endDate)}</div>
            <div className="between small" style={{ marginTop: 8 }}>
              <span className="muted">
                {t.participantCount} {t.participantCount === 1 ? 'traveller' : 'travellers'}
                {t.onlineNow > 0 && <> · <span style={{ color: 'var(--ok)' }}>{t.onlineNow} online</span></>}
              </span>
              <IconArrowRight size={16} aria-hidden="true" />
            </div>
          </Link>
        ))}
        {trips.length === 0 && (
          <div className="panel">
            <h3>Plan your first trip</h3>
            <p className="small muted">Start a trip room below, or join one with an invite code from a friend.</p>
          </div>
        )}
      </section>

      <div className="two-col">
        <CreateTrip />
        <JoinWithCode />
      </div>

      <div className="two-col">
        <Preferences profile={data.preferenceProfile} onSaved={load} />
        <section className="panel">
          <p className="panel-title">What you tend to pick</p>
          <Profile history={data.preferenceProfile.fromHistory} />
        </section>
      </div>

      {data.recommendations.length > 0 && (
        <section>
          <h2>Recommended for you{data.recommendationsFor ? ` in ${data.recommendationsFor}` : ''}</h2>
          <div className="grid-cards">
            {data.recommendations.map((r) => (
              <div key={r.venueId} className="panel">
                <div className="between"><span style={{ fontWeight: 500 }}>{r.name}</span><span className="small">{price(r.pricePerPerson)}</span></div>
                <div className="small muted">{r.category} · {r.neighborhood}</div>
                <div className="tiny faint" style={{ marginTop: 4 }}>{r.why}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {trips.length > 0 && (
        <p className="small muted">
          <IconChartBar size={14} aria-hidden="true" /> Session analytics are on each trip's page.
        </p>
      )}
    </main>
  );
}

function Profile({ history }) {
  if (!history.signals) return <p className="small muted">Pin, vote on or like a few places and your taste profile appears here.</p>;
  return (
    <div className="small stack">
      <div className="list-row"><span className="muted">Places you picked</span><span>{history.signals}</span></div>
      {history.favouriteCategories.length > 0 && (
        <div className="list-row"><span className="muted">Favourite kinds</span><span>{history.favouriteCategories.map((c) => c.name).join(', ')}</span></div>
      )}
      {history.priceRange && (
        <div className="list-row"><span className="muted">Usual price</span><span>{history.priceRange.min === history.priceRange.max ? price(history.priceRange.min) : <>{price(history.priceRange.min)} to {price(history.priceRange.max)} (typical {price(history.priceRange.median)})</>}</span></div>
      )}
      {history.dietaryTagsOfLikedPlaces.length > 0 && (
        <div className="list-row"><span className="muted">Often</span><span>{history.dietaryTagsOfLikedPlaces.map((c) => c.name).join(', ')}</span></div>
      )}
    </div>
  );
}

function CreateTrip() {
  const navigate = useNavigate();
  const [destinations, setDestinations] = useState([]);
  const [form, setForm] = useState({ destination: 'lisbon', startDate: '', endDate: '', totalBudget: '1200', maxParticipants: '8' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get('/destinations').then((r) => setDestinations(r.destinations)).catch(() => {});
  }, []);
  const set = (k) => (e) => {
    setForm({ ...form, [k]: e.target.value });
    setErrors({});
  };

  async function submit(e) {
    e.preventDefault();
    const local = {};
    if (!form.startDate) local.startDate = 'Pick a start date';
    if (!form.endDate) local.endDate = 'Pick an end date';
    if (form.startDate && form.endDate && form.endDate < form.startDate) local.endDate = 'End date is before the start';
    if (!(Number(form.totalBudget) > 0)) local.totalBudget = 'Enter a budget above zero';
    if (Object.keys(local).length) return setErrors(local);
    setBusy(true);
    try {
      const r = await post('/trips', {
        destination: form.destination,
        startDate: form.startDate,
        endDate: form.endDate,
        totalBudget: Number(form.totalBudget),
        maxParticipants: Number(form.maxParticipants),
      });
      navigate(`/trips/${r.tripId}`);
    } catch (err) {
      setErrors({ ...Object.fromEntries((err.details ?? []).map((d) => [d.path, d.message])), form: err.details ? null : err.message });
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit} noValidate>
      <h2>Start a trip</h2>
      <div className="field">
        <label htmlFor="dest">Destination</label>
        <select id="dest" value={form.destination} onChange={set('destination')}>
          {destinations.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
        </select>
      </div>
      <div className="row">
        <div className="field grow">
          <label htmlFor="start">From</label>
          <input id="start" type="date" value={form.startDate} onChange={set('startDate')} />
          {errors.startDate && <div className="error">{errors.startDate}</div>}
        </div>
        <div className="field grow">
          <label htmlFor="end">To</label>
          <input id="end" type="date" value={form.endDate} onChange={set('endDate')} />
          {errors.endDate && <div className="error">{errors.endDate}</div>}
        </div>
      </div>
      <div className="row">
        <div className="field grow">
          <label htmlFor="budget">Group budget (USD)</label>
          <input id="budget" type="number" min="1" step="1" value={form.totalBudget} onChange={set('totalBudget')} />
          {errors.totalBudget && <div className="error">{errors.totalBudget}</div>}
        </div>
        <div className="field" style={{ width: 110 }}>
          <label htmlFor="max">Max people</label>
          <input id="max" type="number" min="1" max="50" value={form.maxParticipants} onChange={set('maxParticipants')} />
        </div>
      </div>
      {errors.form && <div className="error">{errors.form}</div>}
      <button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create trip room'}</button>
    </form>
  );
}

function JoinWithCode() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = code.replace(/[^a-z0-9]/gi, '');
        if (clean.length !== 6) return setError('Invite codes have 6 letters and numbers, like AB-7Q2K');
        navigate(`/join/${clean.toUpperCase()}`);
      }}
      noValidate
    >
      <h2>Join a trip</h2>
      <p className="small muted">Got an invite code from the trip leader? Enter it here.</p>
      <div className="field">
        <label htmlFor="code">Invite code</label>
        <input id="code" value={code} onChange={(e) => { setCode(e.target.value); setError(null); }} placeholder="AB-7Q2K" autoCapitalize="characters" />
        {error && <div className="error">{error}</div>}
      </div>
      <button>Find trip</button>
    </form>
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
    if (ceiling !== '' && !(Number(ceiling) > 0)) return setState({ error: 'Enter an amount above zero, or leave it empty' });
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
      <p className="panel-title">Your needs</p>
      <p className="small muted">The Concierge and conflict checks use these in every trip you join.</p>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {DIETARY.map((t) => (
          <label key={t} className="tag" style={{ cursor: 'pointer', margin: 0, padding: '3px 8px', ...(tags.includes(t) ? { background: 'var(--accent-bg)', color: 'var(--accent-text)' } : {}) }}>
            <input type="checkbox" checked={tags.includes(t)} onChange={() => { toggle(t); setState(null); }} style={{ width: 'auto', minHeight: 0, margin: 0 }} />
            {t}
          </label>
        ))}
      </div>
      <div className="field">
        <label htmlFor="ceiling">Most you want to spend on a trip (USD, optional)</label>
        <input id="ceiling" type="number" min="1" value={ceiling} onChange={(e) => { setCeiling(e.target.value); setState(null); }} placeholder="300" />
      </div>
      {state?.error && <div className="error">{state.error}</div>}
      <div className="row"><button>Save</button>{state?.saved && <span className="small muted">Saved</span>}</div>
    </form>
  );
}
