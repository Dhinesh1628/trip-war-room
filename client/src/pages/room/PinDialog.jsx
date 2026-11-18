import { useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../../lib/api.js';
import { dayInfo, price, toHHMM, toMinutes, VISIT_MINUTES } from '../../lib/format.js';

const CATEGORIES = ['all', 'breakfast', 'lunch', 'dinner', 'cafe', 'bar', 'activity', 'tour', 'museum', 'attraction', 'lodging'];

export function Dialog({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="dim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="between" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="ghost icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Pick a venue from the destination's catalog and a time slot.
export default function PinDialog({ room, initial, onClose }) {
  const [venues, setVenues] = useState([]);
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [venueId, setVenueId] = useState(initial.venueId ?? null);
  const [dayIndex, setDayIndex] = useState(initial.dayIndex ?? 0);
  const [start, setStart] = useState(initial.startTime ?? '');
  const [end, setEnd] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get(`/destinations/${room.trip.destinationSlug}/venues`).then((r) => setVenues(r.venues)).catch((e) => setError(e.message));
  }, [room.trip.destinationSlug]);

  const venue = venues.find((v) => v.venueId === venueId);
  // A sensible default slot: opening time, or the time asked for, for a typical visit length.
  useEffect(() => {
    if (!venue) return;
    const s = start || (venue.hours.open === '00:00' ? '15:00' : venue.hours.open);
    setStart(s);
    setEnd(toHHMM(Math.min(toMinutes(s) + (VISIT_MINUTES[venue.category] ?? 60), 23 * 60 + 59)));
  }, [venueId, venues.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(
    () =>
      venues.filter(
        (v) => (category === 'all' || v.category === category) && (!query || `${v.name} ${v.neighborhood}`.toLowerCase().includes(query.toLowerCase())),
      ),
    [venues, category, query],
  );
  const onBoard = new Set(Object.values(room.items).map((i) => i.venueId));

  async function submit(e) {
    e.preventDefault();
    if (!venue) return setError('Pick a venue first');
    if (!start || !end) return setError('Set a start and end time');
    if (end <= start) return setError('The end time has to be after the start (items end the same day)');
    setBusy(true);
    const r = await room.send('trip.board.pin', { venueId, dayIndex: Number(dayIndex), startTime: start, endTime: end });
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error.message);
  }

  return (
    <Dialog title="Pin a venue" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {!venue || !initial.venueId ? (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <input aria-label="Search venues" placeholder="Search by name or area" value={query} onChange={(e) => setQuery(e.target.value)} />
              <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 140 }}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c === 'all' ? 'All kinds' : c}</option>)}
              </select>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 12 }}>
              {shown.map((v) => (
                <label
                  key={v.venueId}
                  className="between"
                  style={{ padding: '7px 10px', margin: 0, cursor: 'pointer', borderBottom: '1px solid var(--border)', background: v.venueId === venueId ? 'var(--accent-bg)' : 'transparent', color: 'var(--text)' }}
                >
                  <span className="row grow">
                    <input type="radio" name="venue" aria-label={v.name} checked={v.venueId === venueId} onChange={() => { setVenueId(v.venueId); setStart(''); setError(null); }} style={{ width: 'auto', minHeight: 0 }} />
                    <span className="grow">
                      <span style={{ fontWeight: 500, fontSize: 13 }}>{v.name}</span>
                      <span className="tiny muted" style={{ display: 'block' }}>
                        {v.category} · {v.neighborhood} · {v.hours.open}-{v.hours.close}
                        {v.dietaryTags.length > 0 && ` · ${v.dietaryTags.join(', ')}`}
                      </span>
                    </span>
                  </span>
                  <span className="small">{price(v.pricePerPerson)}{onBoard.has(v.venueId) && <span className="tag" style={{ marginLeft: 6 }}>on board</span>}</span>
                </label>
              ))}
              {venues.length > 0 && shown.length === 0 && <p className="small muted" style={{ padding: 10 }}>No venues match.</p>}
            </div>
          </>
        ) : (
          <div className="panel" style={{ marginBottom: 12 }}>
            <div className="between"><span style={{ fontWeight: 500 }}>{venue.name}</span><span>{price(venue.pricePerPerson)}</span></div>
            <div className="small muted">{venue.category} · {venue.neighborhood} · open {venue.hours.open}-{venue.hours.close}</div>
          </div>
        )}
        <div className="row">
          <div className="field grow">
            <label htmlFor="pin-day">Day</label>
            <select id="pin-day" value={dayIndex} onChange={(e) => setDayIndex(e.target.value)}>
              {Array.from({ length: room.trip.dayCount }, (_, d) => <option key={d} value={d}>Day {d + 1} · {dayInfo(room.trip.startDate, d).label}</option>)}
            </select>
          </div>
          <div className="field" style={{ width: 140 }}>
            <label htmlFor="pin-start">From</label>
            <input id="pin-start" type="time" value={start} onChange={(e) => { setStart(e.target.value); setError(null); }} />
          </div>
          <div className="field" style={{ width: 140 }}>
            <label htmlFor="pin-end">To</label>
            <input id="pin-end" type="time" value={end} onChange={(e) => { setEnd(e.target.value); setError(null); }} />
          </div>
        </div>
        {error && <div className="error" role="alert" style={{ marginBottom: 8 }}>{error}</div>}
        <div className="row"><button className="primary" disabled={busy}>{busy ? 'Pinning…' : 'Pin to board'}</button><button type="button" onClick={onClose}>Cancel</button></div>
      </form>
    </Dialog>
  );
}
