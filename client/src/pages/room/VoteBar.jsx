import { useEffect, useState } from 'react';
import { IconCheck, IconX } from '@tabler/icons-react';

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const left = (closesAt, now) => {
  const s = Math.max(0, Math.round((new Date(closesAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Open votes: contested slots (pick one) and budget splits (yes or no).
export default function VoteBar({ room, names }) {
  const now = useNow();
  const [mine, setMine] = useState({});
  const [error, setError] = useState(null);
  const votes = Object.values(room.votes);
  if (!votes.length) return null;

  async function cast(event, payload, voteId, choice) {
    const r = await room.send(event, payload);
    if (r.ok) {
      setMine({ ...mine, [voteId]: choice });
      setError(null);
    } else setError(r.error.message);
  }

  return (
    <section className="stack" aria-label="Open votes">
      {error && <div className="banner danger" role="alert">{error}</div>}
      {votes.map((v) =>
        v.kind === 'split' ? (
          <div key={v.voteId} className="panel" style={{ borderColor: 'var(--accent)' }}>
            <div className="between wrap">
              <div className="small">
                <span style={{ fontWeight: 500 }}>Budget split vote:</span> {names.get(v.openedByUserId) ?? 'Someone'} proposes{' '}
                {v.proposal.attendeeIds?.length ? `only ${v.proposal.attendeeIds.map((id) => names.get(id)).join(', ')} go to` : 'a new split for'} {v.name}
                {v.proposal.split.type === 'weighted' &&
                  ` (shares ${Object.entries(v.proposal.split.weights).map(([id, w]) => `${names.get(id)?.split(' ')[0]} ${w}`).join(' : ')})`}
                <span className="muted"> · {v.tally.yes} yes, {v.tally.no} no · {left(v.closesAt, now)} left</span>
              </div>
              <div className="row">
                <button className={mine[v.voteId] === 'yes' ? 'primary' : ''} onClick={() => cast('trip.split.cast', { voteId: v.voteId, choice: 'yes' }, v.voteId, 'yes')}>
                  <IconCheck size={14} aria-hidden="true" /> Yes
                </button>
                <button className={mine[v.voteId] === 'no' ? 'primary' : ''} onClick={() => cast('trip.split.cast', { voteId: v.voteId, choice: 'no' }, v.voteId, 'no')}>
                  <IconX size={14} aria-hidden="true" /> No
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div key={v.voteId} className="panel" style={{ borderColor: 'var(--accent)' }}>
            <div className="between wrap">
              <div className="small">
                <span style={{ fontWeight: 500 }}>Vote:</span> which one keeps this slot?
                <span className="muted"> · {v.ballotCount} of {room.participants.length} voted · {left(v.closesAt, now)} left</span>
              </div>
              <div className="row wrap">
                {v.candidates.map((c) => (
                  <button
                    key={c.itemId}
                    className={mine[v.voteId] === c.itemId ? 'primary' : ''}
                    onClick={() => cast('trip.vote.cast', { voteId: v.voteId, itemId: c.itemId }, v.voteId, c.itemId)}
                  >
                    {c.name} <span className="tiny">{v.tally[c.itemId] ?? 0}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ),
      )}
    </section>
  );
}
