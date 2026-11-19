import { IconHeart, IconStar } from '@tabler/icons-react';
import Photo, { PhotoCredit } from './Photo.jsx';
import { useSaved } from '../lib/saved.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { cityOf, hoursText, price } from '../lib/format.js';

// A place as a photo card: big rounded photo with a heart, then name and
// rating, city and hours, and the price per person.
export default function VenueCard({ venue, onOpen, note }) {
  const saved = useSaved();
  const { t } = useI18n();
  const isSaved = saved?.has(venue.venueId);
  const per = venue.category === 'lodging' ? t('per night') : t('per person');
  const tr = venue.travellerReviews;
  return (
    <article className="venue-card">
      <button className="venue-open" onClick={() => onOpen?.(venue)} aria-label={`${venue.name}, ${cityOf(venue.destinationName)}, ${price(venue.pricePerPerson, venue.currency)} ${per}`}>
        <Photo image={venue.image} alt="" className="ratio-card" credit={false} />
      </button>
      {/* The credit link sits outside the button: links can't be inside buttons. */}
      <div className="card-credit"><PhotoCredit image={venue.image} /></div>
      <button
        className={`heart ${isSaved ? 'on' : ''}`}
        aria-pressed={Boolean(isSaved)}
        aria-label={isSaved ? t('Remove {name} from saved', { name: venue.name }) : t('Save {name}', { name: venue.name })}
        onClick={() => saved?.toggle(venue.venueId)}
      >
        <IconHeart size={18} stroke={1.8} aria-hidden="true" />
      </button>
      <div className="venue-meta" onClick={() => onOpen?.(venue)}>
        <div className="between">
          <span className="venue-name">{venue.name}</span>
          <span className="rating"><IconStar size={13} aria-hidden="true" /> {venue.rating.toFixed(1)}</span>
        </div>
        <div className="small muted">{cityOf(venue.destinationName)} · {venue.neighborhood} · {hoursText(venue.hours, t)}</div>
        <div className="small"><strong>{price(venue.pricePerPerson, venue.currency)}</strong> <span className="muted">{per}</span></div>
        {tr?.count > 0 && <div className="tiny muted">{t(tr.count === 1 ? '{n} traveller review' : '{n} traveller reviews', { n: tr.count })} · ★ {tr.average.toFixed(1)}</div>}
        {note && <div className="tiny faint">{note}</div>}
      </div>
    </article>
  );
}
