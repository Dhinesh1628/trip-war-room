import { Link } from 'react-router-dom';
import Photo from './Photo.jsx';
import { cityOf, shortRange } from '../lib/format.js';

// One of your trips, as a photo card.
export default function TripCard({ trip, destination }) {
  const people = `${trip.participantCount} ${trip.participantCount === 1 ? 'traveller' : 'travellers'}`;
  return (
    <Link to={`/trips/${trip.tripId}`} className="trip-card" aria-label={`${trip.destination}, ${shortRange(trip.startDate, trip.endDate)}, ${people}, you are ${trip.myRole}`}>
      <Photo image={destination?.image} alt="" className="ratio-trip" credit={false}>
        {trip.onlineNow > 0 && <span className="photo-badge"><span className="dot" aria-hidden="true" /> {trip.onlineNow} online</span>}
      </Photo>
      <div className="venue-meta">
        <div className="venue-name">{cityOf(trip.destination)}</div>
        <div className="small muted">{shortRange(trip.startDate, trip.endDate)} · {people} · {trip.myRole}</div>
      </div>
    </Link>
  );
}
