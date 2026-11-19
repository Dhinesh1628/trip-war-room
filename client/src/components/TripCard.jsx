import { Link } from 'react-router-dom';
import Photo from './Photo.jsx';
import { cityOf, shortRange } from '../lib/format.js';
import { useI18n } from '../lib/i18n.jsx';

// One of your trips, as a photo card.
export default function TripCard({ trip, destination }) {
  const { t, lang } = useI18n();
  const people = t(trip.participantCount === 1 ? '{n} traveller' : '{n} travellers', { n: trip.participantCount });
  return (
    <Link to={`/trips/${trip.tripId}`} className="trip-card" aria-label={`${trip.destination}, ${shortRange(trip.startDate, trip.endDate, lang)}, ${people}, ${t(trip.myRole)}`}>
      <Photo image={destination?.image} alt="" className="ratio-trip" credit={false}>
        {trip.onlineNow > 0 && <span className="photo-badge"><span className="dot" aria-hidden="true" /> {t('{n} online', { n: trip.onlineNow })}</span>}
      </Photo>
      <div className="venue-meta">
        <div className="venue-name">{cityOf(trip.destination)}</div>
        <div className="small muted">{shortRange(trip.startDate, trip.endDate, lang)} · {people} · {t(trip.myRole)}</div>
      </div>
    </Link>
  );
}
