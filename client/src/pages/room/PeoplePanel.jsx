import { useState } from 'react';
import { IconMail } from '@tabler/icons-react';
import { patch, post } from '../../lib/api.js';
import { initials } from '../../lib/format.js';
import { useI18n } from '../../lib/i18n.jsx';

const QUALITY = { good: 'good connection', fair: 'slow connection', poor: 'poor connection' };

// Who's here, inviting by email, and the leader's moderation controls.
export default function PeoplePanel({ room, tripId, isLeader, active, onInviteCode }) {
  const { t } = useI18n();
  const [error, setError] = useState(null);
  const leaderId = room.leader?.leaderUserId;
  const me = room.me.userId;

  const act = async (event, payload) => {
    const r = await room.send(event, payload);
    setError(r.ok ? null : r.error.message);
  };

  return (
    <section className={`panel ${active ? 'active-tab' : ''}`} data-tab="people" aria-label={t('People')}>
      <p className="panel-title">
        <span>{t('People')}</span>
        {isLeader && (
          <button className="ghost small" onClick={() => act('trip.mod.lockRoom', { locked: !room.trip.roomLocked })}>
            {room.trip.roomLocked ? t('Reopen to new people') : t('Close to new people')}
          </button>
        )}
      </p>
      {room.participants.map((p) => (
        <div key={p.userId} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div className="between">
            <span className="row">
              <span className={`avatar ${p.online ? 'online' : ''}`}>{initials(p.displayName)}</span>
              <span>
                <span style={{ fontSize: 13 }}>{p.displayName}{p.userId === me && ` (${t('you')})`}</span>
                <span className="tiny muted" style={{ display: 'block' }}>
                  {t(p.role)}{p.muted && ` · ${t('muted')}`} · {p.online ? t(QUALITY[p.quality] ?? 'online') : t('offline')}
                </span>
              </span>
            </span>
          </div>
          {isLeader && p.userId !== me && p.userId !== leaderId && (
            <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
              <button
                className="ghost small"
                onClick={async () => {
                  try {
                    await patch(`/trips/${tripId}/participants/${p.userId}`, { role: p.role === 'viewer' ? 'planner' : 'viewer' });
                    setError(null);
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              >
                {p.role === 'viewer' ? t('Make planner') : t('Make viewer')}
              </button>
              <button className="ghost small" onClick={() => act('trip.mod.mute', { userId: p.userId, muted: !p.muted })}>{p.muted ? t('Unmute') : t('Mute')}</button>
              <button className="ghost small" onClick={() => act('trip.mod.transferLeader', { userId: p.userId })}>{t('Make leader')}</button>
              <button
                className="ghost small danger"
                onClick={() => window.confirm(t("Remove {name} from the trip? They won't be able to rejoin.", { name: p.displayName })) && act('trip.mod.remove', { userId: p.userId })}
              >
                {t('Remove')}
              </button>
            </div>
          )}
        </div>
      ))}
      {isLeader && <InviteByEmail tripId={tripId} />}
      {isLeader && (
        <button
          className="ghost small"
          style={{ marginTop: 8 }}
          onClick={async () => {
            try {
              const r = await post(`/trips/${tripId}/invite-code`);
              onInviteCode(r.inviteCode);
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          {t('New invite code')}
        </button>
      )}
      {error && <div className="error" role="alert">{error}</div>}
    </section>
  );
}

function InviteByEmail({ tripId }) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [state, setState] = useState(null);
  async function submit(e) {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email)) return setState({ error: t('Enter a valid email address') });
    setState({ busy: true });
    try {
      await post(`/trips/${tripId}/invites`, { email });
      setState({ ok: t('Invite sent to {email}', { email }) });
      setEmail('');
    } catch (err) {
      setState({ error: err.details?.[0]?.message ?? err.message });
    }
  }
  return (
    <form onSubmit={submit} noValidate style={{ marginTop: 10 }}>
      <label htmlFor="invite-email" className="small">{t('Invite by email')}</label>
      <div className="row">
        <input id="invite-email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setState(null); }} placeholder="friend@example.com" autoComplete="off" />
        <button disabled={state?.busy}><IconMail size={14} aria-hidden="true" /> {t('Send')}</button>
      </div>
      {state?.error && <div className="error" role="alert">{state.error}</div>}
      {state?.ok && <div className="small" role="status" style={{ color: 'var(--ok)', marginTop: 4 }}>{state.ok}</div>}
    </form>
  );
}
