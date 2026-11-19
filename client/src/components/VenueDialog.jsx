import { IconHeart, IconStar, IconX, IconMapPin, IconClock } from '@tabler/icons-react';
import Photo from './Photo.jsx';
import { useSaved } from '../lib/saved.jsx';
import { cityOf, hoursText, price } from '../lib/format.js';

// Details of one place, opened from a card.
export default function VenueDialog({ venue, onClose, onPlan }) {
  const saved = useSaved();
  const isSaved = saved?.has(venue.venueId);
  return (
    <div className="dim" onClick={onClose}>
      <div className="dialog venue-dialog" role="dialog" aria-modal="true" aria-label={venue.name} onClick={(e) => e.stopPropagation()}>
        <Photo image={venue.image} alt={venue.name} className="ratio-wide" eager>
          <button className="round-btn photo-close" onClick={onClose} aria-label="Close"><IconX size={18} aria-hidden="true" /></button>
        </Photo>
        <div className="venue-dialog-body">
          <div className="between" style={{ alignItems: 'flex-start' }}>
            <div>
              <h2 style={{ marginBottom: 2 }}>{venue.name}</h2>
              <div className="small muted"><IconStar size={13} aria-hidden="true" /> {venue.rating.toFixed(1)} ({venue.reviewCount.toLocaleString('en-IN')} reviews) · {venue.category}</div>
            </div>
            <button className={`btn ${isSaved ? 'primary' : ''}`} onClick={() => saved?.toggle(venue.venueId)} aria-pressed={Boolean(isSaved)}>
              <IconHeart size={16} aria-hidden="true" /> {isSaved ? 'Saved' : 'Save'}
            </button>
          </div>
          <p style={{ marginTop: 12 }}>{venue.description}</p>
          <div className="detail-rows">
            <div><IconMapPin size={16} aria-hidden="true" /> {venue.neighborhood}, {cityOf(venue.destinationName)}</div>
            <div><IconClock size={16} aria-hidden="true" /> {hoursText(venue.hours)}</div>
            <div><strong>{price(venue.pricePerPerson, venue.currency)}</strong> {venue.category === 'lodging' ? 'per person per night' : 'per person'}</div>
          </div>
          {venue.dietaryTags.length > 0 && (
            <div className="row wrap" style={{ marginTop: 10 }}>
              {venue.dietaryTags.map((t) => <span key={t} className="chip small-chip">{t}</span>)}
            </div>
          )}
          {onPlan && (
            <button className="primary block" style={{ marginTop: 16 }} onClick={() => onPlan(venue)}>
              Plan a trip to {cityOf(venue.destinationName)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
