import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  IconArrowRight, IconMapPin, IconCompass, IconBuildingCastle, IconRoute, IconTicket, IconBuildingBank,
  IconToolsKitchen2, IconCoffee, IconGlassFull, IconBed, IconSearch, IconList, IconMap, IconX, IconCalendar,
} from '@tabler/icons-react';
import { post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { useCatalog, findDestination, EXPLORE_CATEGORIES } from '../lib/catalog.js';
import { DEFAULT_FILTERS, filterVenues, sortVenues, activeFilterCount } from '../lib/filters.js';
import { cityOf, price } from '../lib/format.js';
import Photo from '../components/Photo.jsx';
import VenueCard from '../components/VenueCard.jsx';
import VenueDialog from '../components/VenueDialog.jsx';
// The map library is large, so it loads only when someone opens the map.
const MapView = lazy(() => import('../components/MapView.jsx'));
import DateRangePicker, { useRangeLabel } from '../components/DateRangePicker.jsx';

const Icons = { IconCompass, IconBuildingCastle, IconRoute, IconTicket, IconBuildingBank, IconToolsKitchen2, IconCoffee, IconGlassFull, IconBed };
const PAGE = 12;
const PRICE_CAPS = [300, 500, 1000, 2000, 5000];
const DIETS = ['vegetarian', 'vegan', 'halal', 'gluten-free'];
const SORT_LABELS = { top: 'Top rated', priceLow: 'Price: low to high', priceHigh: 'Price: high to low', reviews: 'Most reviewed' };

// Explore: a photo header with the trip search bar, then every place across
// India with a search box, filters, sorting, and a list or map view.
export default function ExplorePage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const { catalog, error: catalogError } = useCatalog();
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState({ ...DEFAULT_FILTERS, city: params.get('city') ?? 'all', query: params.get('q') ?? '' });
  const [cat, setCat] = useState(params.get('cat') ?? 'all');
  const [sort, setSort] = useState('top');
  const [view, setView] = useState('list');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(null);
  const [where, setWhere] = useState(params.get('plan') ?? '');
  const searchRef = useRef(null);

  const category = EXPLORE_CATEGORIES.find((c) => c.key === cat) ?? EXPLORE_CATEGORIES[0];
  const set = (patch) => {
    setFilters((f) => ({ ...f, ...patch }));
    setShowAll(false);
  };
  useEffect(() => {
    const next = new URLSearchParams();
    if (filters.city !== 'all') next.set('city', filters.city);
    if (cat !== 'all') next.set('cat', cat);
    if (filters.query.trim()) next.set('q', filters.query.trim());
    setParams(next, { replace: true });
  }, [filters.city, filters.query, cat]); // eslint-disable-line react-hooks/exhaustive-deps

  const places = useMemo(
    () => (catalog ? sortVenues(filterVenues(catalog.venues, { ...filters, categories: category.categories }), sort) : []),
    [catalog, filters, category, sort],
  );
  const heroDest = findDestination(catalog, filters.city !== 'all' ? filters.city : where) ?? findDestination(catalog, 'jaipur') ?? catalog?.destinations[0];
  const shown = showAll ? places : places.slice(0, PAGE);
  const extra = activeFilterCount(filters);

  function planTrip(slug) {
    setOpen(null);
    setWhere(slug);
    searchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => searchRef.current?.querySelector('[data-first]')?.focus(), 300);
  }

  const cityName = filters.city === 'all' ? null : cityOf(findDestination(catalog, filters.city)?.name);
  const heading = category.key === 'all' ? t('Top places') : t(category.label);
  return (
    <main className="explore">
      <section className="hero">
        <Photo image={heroDest?.image} alt={heroDest ? cityOf(heroDest.name) : ''} className="hero-photo" eager>
          <div className="hero-shade" aria-hidden="true" />
          <div className="hero-inner">
            <div className="hero-place"><IconMapPin size={14} aria-hidden="true" /> {heroDest ? `${cityOf(heroDest.name)}, ${t('India')}` : t('India')}</div>
            <h1 className="hero-title">{t('Namaste, {name}. Where in India next?', { name: user?.displayName?.split(' ')[0] ?? '' })}</h1>
          </div>
        </Photo>
        <div ref={searchRef} className="search-wrap">
          <TripSearch catalog={catalog} where={where} setWhere={setWhere} />
        </div>
      </section>

      <div className="page explore-body">
        <div className="find-bar">
          <label className="find-input">
            <IconSearch size={18} aria-hidden="true" />
            <input
              type="search"
              value={filters.query}
              onChange={(e) => set({ query: e.target.value })}
              placeholder={t('Search places, areas or food, like "thali" or "fort"')}
              aria-label={t('Search places')}
            />
            {filters.query && <button type="button" className="ghost icon" onClick={() => set({ query: '' })} aria-label={t('Clear search')}><IconX size={16} aria-hidden="true" /></button>}
          </label>
        </div>

        <div className="cat-bar" role="tablist" aria-label={t('Kinds of places')}>
          {EXPLORE_CATEGORIES.map((c) => {
            const Icon = Icons[c.icon];
            return (
              <button key={c.key} role="tab" aria-selected={cat === c.key} className={`cat ${cat === c.key ? 'on' : ''}`} onClick={() => { setCat(c.key); setShowAll(false); }}>
                <Icon size={24} stroke={1.5} aria-hidden="true" />
                <span>{t(c.label)}</span>
              </button>
            );
          })}
        </div>

        <div className="chips" role="group" aria-label={t('City')}>
          <button className={`chip ${filters.city === 'all' ? 'on' : ''}`} aria-pressed={filters.city === 'all'} onClick={() => set({ city: 'all' })}>{t('All India')}</button>
          {catalog?.destinations.map((d) => (
            <button key={d.slug} className={`chip ${filters.city === d.slug ? 'on' : ''}`} aria-pressed={filters.city === d.slug} onClick={() => set({ city: d.slug })}>
              {cityOf(d.name)}
            </button>
          ))}
        </div>

        <div className="filter-bar" role="group" aria-label={t('Filters')}>
          <label className="filter-select">
            <span className="sr-only">{t('Price per person')}</span>
            <select value={filters.maxPrice ?? ''} onChange={(e) => set({ maxPrice: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{t('Any price')}</option>
              {PRICE_CAPS.map((p) => <option key={p} value={p}>{t('Up to {amount}', { amount: price(p) })}</option>)}
            </select>
          </label>
          <label className="filter-select">
            <span className="sr-only">{t('Rating')}</span>
            <select value={filters.minRating ?? ''} onChange={(e) => set({ minRating: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{t('Any rating')}</option>
              <option value="4">{t('Rating {n}+', { n: '4.0' })}</option>
              <option value="4.5">{t('Rating {n}+', { n: '4.5' })}</option>
            </select>
          </label>
          {DIETS.map((d) => {
            const on = filters.diets.includes(d);
            return (
              <button key={d} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => set({ diets: on ? filters.diets.filter((x) => x !== d) : [...filters.diets, d] })}>
                {t(d)}
              </button>
            );
          })}
          <button type="button" className={`chip ${filters.openNow ? 'on' : ''}`} aria-pressed={filters.openNow} onClick={() => set({ openNow: !filters.openNow })}>{t('Open now')}</button>
          {extra > 0 && (
            <button type="button" className="ghost small" onClick={() => set({ ...DEFAULT_FILTERS, city: filters.city })}>{t('Clear filters')}</button>
          )}
          <span className="filter-spacer" />
          <label className="filter-select">
            <span className="sr-only">{t('Sort')}</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {Object.entries(SORT_LABELS).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
            </select>
          </label>
          <div className="seg" role="group" aria-label={t('View')}>
            <button type="button" className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')}><IconList size={16} aria-hidden="true" /> {t('List')}</button>
            <button type="button" className={view === 'map' ? 'on' : ''} aria-pressed={view === 'map'} onClick={() => setView('map')}><IconMap size={16} aria-hidden="true" /> {t('Map')}</button>
          </div>
        </div>

        <section className="section" style={{ marginTop: 20 }} aria-live="polite">
          <div className="section-head">
            <h2>{cityName ? t('{what} in {city}', { what: heading, city: cityName }) : t('{what} across India', { what: heading })}</h2>
            <span className="small muted">{t('{n} places', { n: places.length })}</span>
          </div>
          {catalogError && <div className="banner danger">{t("Couldn't load places")}: {catalogError.message}</div>}
          {!catalog && !catalogError && <p className="muted">{t('Loading places…')}</p>}
          {catalog && places.length === 0 && (
            <div className="empty">
              <h3>{t('No places match')}</h3>
              <p className="muted small">{t('Try fewer filters or a different search.')}</p>
              <button className="pill-btn" onClick={() => { set({ ...DEFAULT_FILTERS, city: filters.city }); setCat('all'); }}>{t('Clear filters')}</button>
            </div>
          )}
          {view === 'map' && places.length > 0 ? (
            <Suspense fallback={<div className="map-box empty"><p className="muted">{t('Loading…')}</p></div>}>
              <MapView venues={places} onOpen={setOpen} label={t('Map of places')} />
            </Suspense>
          ) : (
            <>
              <div className="venue-grid">
                {shown.map((v) => <VenueCard key={v.venueId} venue={v} onOpen={setOpen} />)}
              </div>
              {places.length > PAGE && (
                <div style={{ textAlign: 'center', marginTop: 16 }}>
                  <button className="pill-btn" onClick={() => setShowAll(!showAll)}>{showAll ? t('Show fewer') : t('Show all {n}', { n: places.length })}</button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {open && <VenueDialog venue={open} onClose={() => setOpen(null)} onPlan={(v) => planTrip(v.destination)} />}
    </main>
  );
}

// "Where / When / Who / Budget" pill. Submitting creates the trip room.
export function TripSearch({ catalog, where, setWhere }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [form, setForm] = useState({ startDate: '', endDate: '', people: '4', budget: '40000' });
  const [calendar, setCalendar] = useState(false);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const range = useRangeLabel(form.startDate, form.endDate);
  const set = (k) => (e) => {
    setForm({ ...form, [k]: e.target.value });
    setErrors({});
  };

  async function submit(e) {
    e.preventDefault();
    const local = {};
    if (!where) local.where = t('Pick a city');
    if (!form.startDate) local.when = t('Pick your dates');
    else if (!form.endDate) local.when = t('Pick an end date');
    if (!(Number(form.people) >= 1 && Number(form.people) <= 50)) local.people = t('Between 1 and 50 people');
    if (!(Number(form.budget) > 0)) local.budget = t('Enter a budget above ₹0');
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
    <form className="search-pill" onSubmit={submit} noValidate aria-label={t('Plan a trip')}>
      <label className={`sp-field ${errors.where ? 'bad' : ''}`}>
        <span className="sp-label">{t('Where')}</span>
        <select data-first value={where} onChange={(e) => { setWhere(e.target.value); setErrors({}); }} aria-invalid={Boolean(errors.where)}>
          <option value="">{t('Choose a city')}</option>
          {catalog?.destinations.map((d) => <option key={d.slug} value={d.slug}>{cityOf(d.name)}</option>)}
        </select>
      </label>
      <span className="sp-div" aria-hidden="true" />
      <div className={`sp-field sp-when ${errors.when ? 'bad' : ''}`}>
        <span className="sp-label" id="when-label">{t('When')}</span>
        <button type="button" className="sp-date-btn" aria-labelledby="when-label when-value" aria-expanded={calendar} onClick={() => setCalendar(!calendar)}>
          <IconCalendar size={16} aria-hidden="true" />
          <span id="when-value">{range ? (typeof range === 'string' ? `${range} – …` : `${range.text} · ${t('{n} days', { n: range.days })}`) : t('Add dates')}</span>
        </button>
        {calendar && (
          <DateRangePicker
            start={form.startDate}
            end={form.endDate}
            onChange={({ start, end }) => { setForm((f) => ({ ...f, startDate: start, endDate: end })); setErrors({}); }}
            onClose={() => setCalendar(false)}
          />
        )}
      </div>
      <span className="sp-div" aria-hidden="true" />
      <label className={`sp-field sp-small ${errors.people ? 'bad' : ''}`}>
        <span className="sp-label">{t('Who')}</span>
        <span className="row" style={{ gap: 4 }}>
          <input type="number" min="1" max="50" value={form.people} onChange={set('people')} aria-label={t('Most people')} />
          <span className="small muted">{t('people')}</span>
        </span>
      </label>
      <span className="sp-div" aria-hidden="true" />
      <label className={`sp-field sp-small ${errors.budget ? 'bad' : ''}`}>
        <span className="sp-label">{t('Budget')}</span>
        <span className="row" style={{ gap: 2 }}>
          <span className="muted">₹</span>
          <input type="number" min="1" step="500" value={form.budget} onChange={set('budget')} aria-label={t('Group budget in rupees')} />
        </span>
      </label>
      <button className="sp-go" disabled={busy} aria-label={t('Create trip room')}>
        <IconArrowRight size={20} aria-hidden="true" />
        <span className="sp-go-text">{busy ? t('Creating…') : t('Create trip')}</span>
      </button>
      {firstError && <div className="sp-error" role="alert">{firstError}</div>}
    </form>
  );
}
