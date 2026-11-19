import { IconHeart, IconStar } from '@tabler/icons-react';
import Photo from './Photo.jsx';
import { useSaved } from '../lib/saved.jsx';
import { cityOf, hoursText, price } from '../lib/format.js';

// A place as a photo card: big rounded photo with a heart, then name and
// rating, city and hours, and the price per person.
export default function VenueCard({ venue, onOpen, note }) {
  const saved = useSaved();
  const isSaved = saved?.has(venue.venueId);
  const per = venue.category === 'lodging' ? 'per night' : 'per person';
  return (
    <article className="venue-card">
      <button className="venue-open" onClick={() => onOpen?.(venue)} aria-label={`${venue.name}, ${cityOf(venue.destinationName)}, ${price(venue.pricePerPerson, venue.currency)} ${per}`}>
        <Photo image={venue.image} alt="" className="ratio-card" />
      </button>
      <button
        className={`heart ${isSaved ? 'on' : ''}`}
        aria-pressed={Boolean(isSaved)}
        aria-label={isSaved ? `Remove ${venue.name} from saved` : `Save ${venue.name}`}
        onClick={() => saved?.toggle(venue.venueId)}
      >
        <IconHeart size={18} stroke={1.8} aria-hidden="true" />
      </button>
      <div className="venue-meta" onClick={() => onOpen?.(venue)}>
        <div className="between">
          <span className="venue-name">{venue.name}</span>
          <span className="rating"><IconStar size={13} aria-hidden="true" /> {venue.rating.toFixed(1)}</span>
        </div>
        <div className="small muted">{cityOf(venue.destinationName)} · {venue.neighborhood} · {hoursText(venue.hours)}</div>
        <div className="small"><strong>{price(venue.pricePerPerson, venue.currency)}</strong> <span className="muted">{per}</span></div>
        {note && <div className="tiny faint">{note}</div>}
      </div>
    </article>
  );
}
