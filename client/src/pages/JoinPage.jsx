import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../lib/api.js';
import { dateRange } from '../lib/format.js';

export default function JoinPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get(`/trips/invite/${encodeURIComponent(code)}`)
      .then((p) => (p.alreadyJoined ? navigate(`/trips/${p.tripId}`, { replace: true }) : setPreview(p)))
      .catch((e) => setError(e.status === 404 ? "That invite code doesn't match a trip. Check it with the leader." : e.message));
  }, [code, navigate]);

  async function join() {
    setBusy(true);
    try {
      const r = await post('/trips/join', { inviteCode: code });
      navigate(`/trips/${r.trip.tripId}`);
    } catch (e) {
      setError(
        e.code === 'ROOM_FULL' ? 'This trip is full.' : e.code === 'ROOM_LOCKED' ? 'The leader has closed this trip to new travellers.' : e.message,
      );
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <div className="panel" style={{ padding: 20 }}>
        {error && (
          <>
            <h1>Can't join</h1>
            <div className="banner danger" role="alert">{error}</div>
            <p style={{ marginTop: 12 }}><Link to="/">Back to your trips</Link></p>
          </>
        )}
        {!error && !preview && <p className="muted">Looking up the invite…</p>}
        {!error && preview && (
          <>
            <p className="small muted">{preview.leaderName} invited you to</p>
            <h1>{preview.destination}</h1>
            <p className="muted">{dateRange(preview.startDate, preview.endDate)}</p>
            <p className="small muted">
              {preview.participantCount} of {preview.maxParticipants} travellers so far. You'll join as a {preview.joinRole}.
            </p>
            <button className="primary" onClick={join} disabled={busy}>{busy ? 'Joining…' : 'Join trip'}</button>
          </>
        )}
      </div>
    </main>
  );
}
