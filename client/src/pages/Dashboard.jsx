import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IconArrowRight, IconPlus, IconUsers, IconMapPin, IconCompass, IconBuildingCastle, IconRoute, IconTicket,
  IconBuildingBank, IconToolsKitchen2, IconCoffee, IconGlassFull, IconBed,
} from '@tabler/icons-react';

const Icons = { IconCompass, IconBuildingCastle, IconRoute, IconTicket, IconBuildingBank, IconToolsKitchen2, IconCoffee, IconGlassFull, IconBed };
import { get, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useCatalog, findDestination, EXPLORE_CATEGORIES } from '../lib/catalog.js';
import { cityOf } from '../lib/format.js';
import Photo from '../components/Photo.jsx';
import VenueCard from '../components/VenueCard.jsx';
import VenueDialog from '../components/VenueDialog.jsx';
import TripCard from '../components/TripCard.jsx';

const PAGE = 12;

// Explore: the home page. A photo header with the trip search bar, category
// buttons, city chips, your trips, and places across India.
export default function Dashboard() {
  const { user } = useAuth();
  const { catalog, error: catalogError } = useCatalog();
  const [dash, setDash] = useState(null);
  const [cat, setCat] = useState('all');
  const [city, setCity] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(null);
  const [where, setWhere] = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    get('/users/me/dashboard').then(setDash).catch(() => setDash({ trips: { led: [], joined: [] }, recommendations: [], activeRooms: [] }));
  }, []);
  useEffect(() => setShowAll(false), [cat, city]);

  const category = EXPLORE_CATEGORIES.find((c) => c.key === cat);
  const places = useMemo(() => {
    if (!catalog) return [];
    return catalog.venues
      .filter((v) => (city === 'all' || v.destination === city) && (!category.categories || category.categories.includes(v.category)))
      .sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount);
  }, [catalog, city, category]);

  const heroDest = findDestination(catalog, city !== 'all' ? city : where) ?? catalog?.destinations.find((d) => d.slug === 'jaipur') ?? catalog?.destinations[0];
  const trips = dash ? [...dash.trips.led, ...dash.trips.joined] : [];
  const recs = (dash?.recommendations ?? []).map((r) => ({ rec: r, venue: catalog?.byId.get(r.venueId) })).filter((x) => x.venue);
  const first = user?.displayName?.split(' ')[0] ?? 'there';
  const shown = showAll ? places : places.slice(0, PAGE);

  function planTrip(slug) {
    setOpen(null);
    setWhere(slug);
    searchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => searchRef.current?.querySelector('[data-first]')?.focus(), 300);
  }

  return (
    <main className="explore">
      <section className="hero">
        <Photo image={heroDest?.image} alt={heroDest ? `${cityOf(heroDest.name)}` : ''} className="hero-photo" eager>
          <div className="hero-shade" aria-hidden="true" />
          <div className="hero-inner">
            <div className="hero-place"><IconMapPin size={14} aria-hidden="true" /> {heroDest ? `${cityOf(heroDest.name)}, India` : 'India'}</div>
            <h1 className="hero-title">Namaste, {first}. Where in India next?</h1>
          </div>
        </Photo>
        <div ref={searchRef} className="search-wrap">
          <TripSearch catalog={catalog} where={where} setWhere={setWhere} />
        </div>
      </section>

      <div className="page explore-body">
        {dash?.activeRooms?.length > 0 && (
          <div className="banner info">
            <IconUsers size={16} aria-hidden="true" />
            <span>Planning now: {dash.activeRooms.map((t) => `${cityOf(t.destination)} (${t.onlineNow} online)`).join(', ')}</span>
          </div>
        )}

        <div className="cat-bar" role="tablist" aria-label="Kinds of places">
          {EXPLORE_CATEGORIES.map((c) => {
            const Icon = Icons[c.icon];
            return (
              <button key={c.key} role="tab" aria-selected={cat === c.key} className={`cat ${cat === c.key ? 'on' : ''}`} onClick={() => setCat(c.key)}>
                <Icon size={24} stroke={1.5} aria-hidden="true" />
                <span>{c.label}</span>
              </button>
            );
          })}
        </div>

        <div className="chips" role="group" aria-label="City">
          <button className={`chip ${city === 'all' ? 'on' : ''}`} aria-pressed={city === 'all'} onClick={() => setCity('all')}>All India</button>
          {catalog?.destinations.map((d) => (
            <button key={d.slug} className={`chip ${city === d.slug ? 'on' : ''}`} aria-pressed={city === d.slug} onClick={() => setCity(d.slug)}>
              {cityOf(d.name)}
            </button>
          ))}
        </div>

        {(trips.length > 0 || dash) && (
          <section className="section">
            <div className="section-head">
              <h2>Your trips</h2>
              {trips.length > 0 && <span className="small muted">{trips.length} {trips.length === 1 ? 'trip' : 'trips'}</span>}
            </div>
            <div className="card-row">
              {trips.map((t) => <TripCard key={t.tripId} trip={t} destination={findDestination(catalog, t.destination)} />)}
              <button className="new-trip" onClick={() => planTrip(city !== 'all' ? city : where)}>
                <IconPlus size={22} aria-hidden="true" />
                <span>Plan a new trip</span>
              </button>
            </div>
          </section>
        )}

        <section className="section">
          <div className="section-head">
            <h2>{category.key === 'all' ? 'Top places' : category.label} {city === 'all' ? 'across India' : `in ${cityOf(findDestination(catalog, city)?.name)}`}</h2>
            <span className="small muted">{places.length} places</span>
          </div>
          {catalogError && <div className="banner danger">Couldn't load places: {catalogError.message}</div>}
          {!catalog && !catalogError && <p className="muted">Loading places…</p>}
          <div className="venue-grid">
            {shown.map((v) => <VenueCard key={v.venueId} venue={v} onOpen={setOpen} />)}
          </div>
          {places.length > PAGE && (
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button className="pill-btn" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${places.length}`}</button>
            </div>
          )}
        </section>

        {recs.length > 0 && (
          <section className="section">
            <div className="section-head">
              <h2>Recommended for you{dash.recommendationsFor ? ` in ${cityOf(dash.recommendationsFor)}` : ''}</h2>
            </div>
            <div className="card-row">
              {recs.map(({ rec, venue }) => <VenueCard key={venue.venueId} venue={venue} onOpen={setOpen} note={rec.why} />)}
            </div>
          </section>
        )}
      </div>

      {open && <VenueDialog venue={open} onClose={() => setOpen(null)} onPlan={(v) => planTrip(v.destination)} />}
    </main>
  );
}

// "Where / When / Who / Budget" pill. Submitting creates the trip room.
function TripSearch({ catalog, where, setWhere }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ startDate: '', endDate: '', people: '4', budget: '40000' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => {
    setForm({ ...form, [k]: e.target.value });
    setErrors({});
  };

  async function submit(e) {
    e.preventDefault();
    const local = {};
    if (!where) local.where = 'Pick a city';
    if (!form.startDate) local.when = 'Pick your dates';
    else if (!form.endDate) local.when = 'Pick an end date';
    else if (form.endDate < form.startDate) local.when = 'The end date is before the start';
    if (!(Number(form.people) >= 1 && Number(form.people) <= 50)) local.people = 'Between 1 and 50 people';
    if (!(Number(form.budget) > 0)) local.budget = 'Enter a budget above ₹0';
    if (Object.keys(local).length) return setErrors(local);
    setBusy(true);
    try {
      const r = await post('/trips', {
        destination: where,
        startDate: form.startDate,
        endDate: form.endDate,
        totalBudget: Number(form.budget),
        maxParticipants: Number(form.people),
      });
      navigate(`/trips/${r.tripId}`);
    } catch (err) {
      setErrors({ form: err.details?.map((d) => d.message).join('. ') || err.message });
      setBusy(false);
    }
  }

  const firstError = Object.values(errors).find(Boolean);
  return (
    <form className="search-pill" onSubmit={submit} noValidate aria-label="Plan a trip">
      <label className={`sp-field ${errors.where ? 'bad' : ''}`}>
        <span className="sp-label">Where</span>
        <select data-first value={where} onChange={(e) => { setWhere(e.target.value); setErrors({}); }} aria-invalid={Boolean(errors.where)}>
          <option value="">Choose a city</option>
          {catalog?.destinations.map((d) => <option key={d.slug} value={d.slug}>{cityOf(d.name)}</option>)}
        </select>
      </label>
      <span className="sp-div" aria-hidden="true" />
      <div className={`sp-field sp-when ${errors.when ? 'bad' : ''}`}>
        <span className="sp-label">When</span>
        <div className="row" style={{ gap: 4 }}>
          <input type="date" aria-label="Start date" value={form.startDate} onChange={set('startDate')} />
          <input type="date" aria-label="End date" value={form.endDate} min={form.startDate || undefined} onChange={set('endDate')} />
        </div>
      </div>
      <span className="sp-div" aria-hidden="true" />
      <label className={`sp-field sp-small ${errors.people ? 'bad' : ''}`}>
        <span className="sp-label">Who</span>
        <span className="row" style={{ gap: 4 }}>
          <input type="number" min="1" max="50" value={form.people} onChange={set('people')} aria-label="Most people" />
          <span className="small muted">people</span>
        </span>
      </label>
      <span className="sp-div" aria-hidden="true" />
      <label className={`sp-field sp-small ${errors.budget ? 'bad' : ''}`}>
        <span className="sp-label">Budget</span>
        <span className="row" style={{ gap: 2 }}>
          <span className="muted">₹</span>
          <input type="number" min="1" step="500" value={form.budget} onChange={set('budget')} aria-label="Group budget in rupees" />
        </span>
      </label>
      <button className="sp-go" disabled={busy} aria-label="Create trip room">
        <IconArrowRight size={20} aria-hidden="true" />
        <span className="sp-go-text">{busy ? 'Creating…' : 'Create trip'}</span>
      </button>
      {firstError && <div className="sp-error" role="alert">{firstError}</div>}
    </form>
  );
}
