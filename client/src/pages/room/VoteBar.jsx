import { useEffect, useState } from 'react';
import { IconCheck, IconX } from '@tabler/icons-react';
import { useI18n } from '../../lib/i18n.jsx';

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const left = (closesAt, now) => {
  const s = Math.max(0, Math.round((new Date(closesAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Open votes: contested slots (pick one) and budget splits (yes or no).
export default function VoteBar({ room, names }) {
  const { t } = useI18n();
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
    <section className="stack" aria-label={t('Open votes')}>
      {error && <div className="banner danger" role="alert">{error}</div>}
      {votes.map((v) =>
        v.kind === 'split' ? (
          <div key={v.voteId} className="panel" style={{ borderColor: 'var(--accent)' }}>
            <div className="between wrap">
              <div className="small">
                <span style={{ fontWeight: 500 }}>{t('Budget split vote:')}</span>{' '}
                {v.proposal.attendeeIds?.length
                  ? t('{who} proposes only {names} go to {place}', { who: names.get(v.openedByUserId) ?? t('Someone'), names: v.proposal.attendeeIds.map((id) => names.get(id)).join(', '), place: v.name })
                  : t('{who} proposes a new split for {place}', { who: names.get(v.openedByUserId) ?? t('Someone'), place: v.name })}
                {v.proposal.split.type === 'weighted' &&
                  ` (${t('shares')} ${Object.entries(v.proposal.split.weights).map(([id, w]) => `${names.get(id)?.split(' ')[0]} ${w}`).join(' : ')})`}
                <span className="muted"> · {t('{yes} yes, {no} no', { yes: v.tally.yes, no: v.tally.no })} · {t('{time} left', { time: left(v.closesAt, now) })}</span>
              </div>
              <div className="row">
                <button className={mine[v.voteId] === 'yes' ? 'primary' : ''} aria-pressed={mine[v.voteId] === 'yes'} onClick={() => cast('trip.split.cast', { voteId: v.voteId, choice: 'yes' }, v.voteId, 'yes')}>
                  <IconCheck size={14} aria-hidden="true" /> {t('Yes')}
                </button>
                <button className={mine[v.voteId] === 'no' ? 'primary' : ''} aria-pressed={mine[v.voteId] === 'no'} onClick={() => cast('trip.split.cast', { voteId: v.voteId, choice: 'no' }, v.voteId, 'no')}>
                  <IconX size={14} aria-hidden="true" /> {t('No')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div key={v.voteId} className="panel" style={{ borderColor: 'var(--accent)' }}>
            <div className="between wrap">
              <div className="small">
                <span style={{ fontWeight: 500 }}>{t('Vote:')}</span> {t('which one keeps this slot?')}
                <span className="muted"> · {t('{n} of {total} voted', { n: v.ballotCount, total: room.participants.length })} · {t('{time} left', { time: left(v.closesAt, now) })}</span>
              </div>
              <div className="row wrap">
                {v.candidates.map((c) => (
                  <button
                    key={c.itemId}
                    className={mine[v.voteId] === c.itemId ? 'primary' : ''}
                    aria-pressed={mine[v.voteId] === c.itemId}
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
