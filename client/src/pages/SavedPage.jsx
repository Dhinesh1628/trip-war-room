import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCatalog } from '../lib/catalog.js';
import { useSaved } from '../lib/saved.jsx';
import VenueCard from '../components/VenueCard.jsx';
import VenueDialog from '../components/VenueDialog.jsx';

// Places saved with the heart button, newest first.
export default function SavedPage() {
  const { catalog } = useCatalog();
  const saved = useSaved();
  const [open, setOpen] = useState(null);
  const venues = catalog ? saved.ids.map((id) => catalog.byId.get(id)).filter(Boolean) : [];

  return (
    <main className="page">
      <div className="section-head">
        <h1>Saved</h1>
        {venues.length > 0 && <span className="small muted">{venues.length} {venues.length === 1 ? 'place' : 'places'}</span>}
      </div>
      {saved.error && <div className="banner danger" role="alert">{saved.error}</div>}
      {!catalog && <p className="muted">Loading…</p>}
      {catalog && venues.length === 0 && (
        <div className="empty">
          <h2>Save places you like</h2>
          <p className="muted">Tap the heart on any place in <Link to="/">Explore</Link>. Saved places also shape what we recommend.</p>
        </div>
      )}
      <div className="venue-grid">
        {venues.map((v) => <VenueCard key={v.venueId} venue={v} onOpen={setOpen} />)}
      </div>
      {open && <VenueDialog venue={open} onClose={() => setOpen(null)} />}
    </main>
  );
}
