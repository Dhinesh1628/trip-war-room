import { useEffect, useRef, useState } from 'react';
import { IconHeart, IconStar, IconX, IconMapPin, IconClock, IconWalk } from '@tabler/icons-react';
import Photo from './Photo.jsx';
import { useSaved } from '../lib/saved.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { api, get, put } from '../lib/api.js';
import { cityOf, hoursText, price } from '../lib/format.js';

// Details of one place, opened from a card: photo, facts, the closest places
// on foot (real footpaths), and traveller reviews (read and write your own).
export default function VenueDialog({ venue, onClose, onPlan }) {
  const saved = useSaved();
  const { t } = useI18n();
  const isSaved = saved?.has(venue.venueId);
  const [nearby, setNearby] = useState(null);
  const box = useRef(null);
  const base = `/destinations/${venue.destination}/venues/${venue.venueId}`;

  useEffect(() => {
    get(base).then((r) => setNearby(r.nearby)).catch(() => setNearby([]));
  }, [base]);
  useEffect(() => {
    box.current?.focus();
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  return (
    <div className="dim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog venue-dialog" role="dialog" aria-modal="true" aria-label={venue.name} tabIndex={-1} ref={box}>
        <Photo image={venue.image} alt={venue.name} className="ratio-wide" eager>
          <button className="round-btn photo-close" onClick={onClose} aria-label={t('Close')}><IconX size={18} aria-hidden="true" /></button>
        </Photo>
        <div className="venue-dialog-body">
          <div className="between" style={{ alignItems: 'flex-start' }}>
            <div>
              <h2 style={{ marginBottom: 2 }}>{venue.name}</h2>
              <div className="small muted">
                <IconStar size={13} aria-hidden="true" /> {venue.rating.toFixed(1)} · {t('{n} ratings', { n: venue.reviewCount.toLocaleString('en-IN') })} · {t(venue.category)}
              </div>
            </div>
            <button className={`btn ${isSaved ? 'primary' : ''}`} onClick={() => saved?.toggle(venue.venueId)} aria-pressed={Boolean(isSaved)}>
              <IconHeart size={16} aria-hidden="true" /> {isSaved ? t('Saved') : t('Save')}
            </button>
          </div>
          {venue.image?.representative && <p className="tiny muted" style={{ marginTop: 8 }}>{t('The photo shows a related dish, street or landmark, not this exact place.')}</p>}
          <p style={{ marginTop: 12 }}>{venue.description}</p>
          <div className="detail-rows">
            <div><IconMapPin size={16} aria-hidden="true" /> {venue.neighborhood}, {cityOf(venue.destinationName)}</div>
            <div><IconClock size={16} aria-hidden="true" /> {hoursText(venue.hours, t)}</div>
            <div><strong>{price(venue.pricePerPerson, venue.currency)}</strong> {venue.category === 'lodging' ? t('per person per night') : t('per person')}</div>
          </div>
          {venue.dietaryTags.length > 0 && (
            <div className="row wrap" style={{ marginTop: 10 }}>
              {venue.dietaryTags.map((d) => <span key={d} className="chip small-chip">{t(d)}</span>)}
            </div>
          )}

          {nearby?.length > 0 && (
            <section className="dialog-section" aria-label={t('Nearby on foot')}>
              <h3>{t('Nearby on foot')}</h3>
              {nearby.map((n) => (
                <div key={n.venueId} className="list-row">
                  <span>{n.name} <span className="muted tiny">· {t(n.category)}</span></span>
                  <span className="muted"><IconWalk size={14} aria-hidden="true" /> {t('{n} min walk', { n: n.walkMinutes })}</span>
                </div>
              ))}
              <p className="tiny faint" style={{ margin: '4px 0 0' }}>{t('Walking times follow real footpaths (OpenStreetMap).')}</p>
            </section>
          )}

          <Reviews base={base} />

          {onPlan && (
            <button className="primary block" style={{ marginTop: 16 }} onClick={() => onPlan(venue)}>
              {t('Plan a trip to {city}', { city: cityOf(venue.destinationName) })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stars({ value, onChange, label }) {
  const { t } = useI18n();
  return (
    <div className="stars" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={t(n === 1 ? '{n} star' : '{n} stars', { n })}
          className={`star ${n <= value ? 'on' : ''}`}
          onClick={() => onChange(n)}
        >
          <IconStar size={20} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function Reviews({ base }) {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const [data, setData] = useState(null);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState(null);
  const load = () =>
    get(`${base}/reviews`)
      .then((r) => {
        setData(r);
        if (r.mine) {
          setRating(r.mine.rating);
          setText(r.mine.text);
        }
      })
      .catch((e) => setState({ error: e.message }));
  useEffect(() => {
    load();
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    if (!rating) return setState({ error: t('Choose 1 to 5 stars') });
    if (text.length > 1000) return setState({ error: t('A review can be at most 1,000 characters') });
    setState({ busy: true });
    try {
      await put(`${base}/reviews`, { rating, text: text.trim() });
      setEditing(false);
      setState({ saved: true });
      load();
    } catch (err) {
      setState({ error: err.message });
    }
  }
  async function remove() {
    setState({ busy: true });
    try {
      await api('DELETE', `${base}/reviews`);
      setRating(0);
      setText('');
      setState(null);
      load();
    } catch (err) {
      setState({ error: err.message });
    }
  }

  const when = (iso) => new Date(iso).toLocaleDateString(lang === 'en' ? 'en-IN' : `${lang}-IN`, { month: 'short', year: 'numeric' });
  const showForm = !data?.mine || editing;
  return (
    <section className="dialog-section" aria-label={t('Traveller reviews')}>
      <div className="between">
        <h3 style={{ margin: 0 }}>{t('Traveller reviews')}</h3>
        {data?.summary.count > 0 && <span className="small muted">★ {data.summary.average.toFixed(1)} · {t(data.summary.count === 1 ? '{n} review' : '{n} reviews', { n: data.summary.count })}</span>}
      </div>
      {data && data.reviews.length === 0 && <p className="small muted" style={{ marginTop: 6 }}>{t('No reviews yet. Be the first to write one.')}</p>}
      {data?.reviews.map((r) => (
        <article key={r.reviewId} className="review">
          <div className="between">
            <span className="small"><strong>{r.displayName}</strong>{r.userId === user?.id && ` (${t('you')})`}</span>
            <span className="tiny muted" aria-label={t('{n} of 5 stars', { n: r.rating })}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} · {when(r.updatedAt)}</span>
          </div>
          {r.text && <p className="small" style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap' }}>{r.text}</p>}
        </article>
      ))}

      {showForm ? (
        <form className="review-form" onSubmit={submit} noValidate>
          <label id="rate-label" className="small">{data?.mine ? t('Edit your review') : t('Write a review')}</label>
          <Stars value={rating} onChange={(n) => { setRating(n); setState(null); }} label={t('Your rating')} />
          <textarea rows={3} maxLength={1000} value={text} onChange={(e) => { setText(e.target.value); setState(null); }} placeholder={t('What was good, what to know before you go')} aria-label={t('Your review')} />
          <div className="between">
            <span className="tiny faint">{text.length}/1000</span>
            <span className="row">
              {editing && <button type="button" className="ghost" onClick={() => setEditing(false)}>{t('Cancel')}</button>}
              <button className="primary" disabled={state?.busy}>{data?.mine ? t('Update review') : t('Post review')}</button>
            </span>
          </div>
        </form>
      ) : (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="ghost small" onClick={() => setEditing(true)}>{t('Edit your review')}</button>
          <button className="ghost small danger" onClick={remove}>{t('Delete your review')}</button>
        </div>
      )}
      {state?.error && <div className="error" role="alert">{state.error}</div>}
      {state?.saved && <div className="small muted" role="status">{t('Thanks, your review is posted.')}</div>}
    </section>
  );
}
