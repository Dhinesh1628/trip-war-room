import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../lib/api.js';
import { dateRange } from '../lib/format.js';
import { useI18n } from '../lib/i18n.jsx';

export default function JoinPage() {
  const { code } = useParams();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get(`/trips/invite/${encodeURIComponent(code)}`)
      .then((p) => (p.alreadyJoined ? navigate(`/trips/${p.tripId}`, { replace: true }) : setPreview(p)))
      .catch((e) => setError(e.status === 404 ? t("That invite code doesn't match a trip. Check it with the leader.") : e.message));
  }, [code, navigate]);

  async function join() {
    setBusy(true);
    try {
      const r = await post('/trips/join', { inviteCode: code });
      navigate(`/trips/${r.trip.tripId}`);
    } catch (e) {
      setError(
        e.code === 'ROOM_FULL' ? t('This trip is full.') : e.code === 'ROOM_LOCKED' ? t('The leader has closed this trip to new travellers.') : e.message,
      );
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <div className="panel" style={{ padding: 20 }}>
        {error && (
          <>
            <h1>{t("Can't join")}</h1>
            <div className="banner danger" role="alert">{error}</div>
            <p style={{ marginTop: 12 }}><Link to="/trips">{t('Back to your trips')}</Link></p>
          </>
        )}
        {!error && !preview && <p className="muted">{t('Looking up the invite…')}</p>}
        {!error && preview && (
          <>
            <p className="small muted">{t('{name} invited you to', { name: preview.leaderName })}</p>
            <h1>{preview.destination}</h1>
            <p className="muted">{dateRange(preview.startDate, preview.endDate, lang)}</p>
            <p className="small muted">
              {t("{n} of {max} travellers so far. You'll join as a {role}.", { n: preview.participantCount, max: preview.maxParticipants, role: t(preview.joinRole) })}
            </p>
            <button className="primary" onClick={join} disabled={busy}>{busy ? t('Joining…') : t('Join trip')}</button>
          </>
        )}
      </div>
    </main>
  );
}
