import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconPlus, IconTicket } from '@tabler/icons-react';
import { get } from '../lib/api.js';
import { useCatalog, findDestination } from '../lib/catalog.js';
import TripCard from '../components/TripCard.jsx';
import { JoinDialog } from '../components/Shell.jsx';

// All your trips: the ones you lead and the ones you joined.
export default function TripsPage() {
  const { catalog } = useCatalog();
  const [dash, setDash] = useState(null);
  const [error, setError] = useState(null);
  const [joining, setJoining] = useState(false);
  useEffect(() => {
    get('/users/me/dashboard').then(setDash).catch((e) => setError(e.message));
  }, []);

  if (error) return <main className="page"><div className="banner danger">{error}</div></main>;
  if (!dash) return <main className="page muted">Loading your trips…</main>;
  const groups = [
    ['Trips you lead', dash.trips.led],
    ['Trips you joined', dash.trips.joined],
  ];
  const none = !dash.trips.led.length && !dash.trips.joined.length;

  return (
    <main className="page">
      <div className="section-head">
        <h1>Trips</h1>
        <div className="row">
          <button className="pill-btn" onClick={() => setJoining(true)}><IconTicket size={16} aria-hidden="true" /> Join with code</button>
          <Link className="pill-btn dark" to="/"><IconPlus size={16} aria-hidden="true" /> Plan a trip</Link>
        </div>
      </div>
      {none && (
        <div className="empty">
          <h2>Plan your first trip</h2>
          <p className="muted">Pick a city, dates and a budget on Explore, or join a friend's trip with their invite code.</p>
        </div>
      )}
      {groups.map(([title, trips]) => trips.length > 0 && (
        <section key={title} className="section">
          <h2>{title}</h2>
          <div className="venue-grid">
            {trips.map((t) => <TripCard key={t.tripId} trip={t} destination={findDestination(catalog, t.destination)} />)}
          </div>
        </section>
      ))}
      {joining && <JoinDialog onClose={() => setJoining(false)} />}
    </main>
  );
}
