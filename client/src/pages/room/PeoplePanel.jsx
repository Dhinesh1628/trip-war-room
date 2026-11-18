import { useState } from 'react';
import { patch, post } from '../../lib/api.js';
import { initials } from '../../lib/format.js';

const QUALITY = { good: 'good connection', fair: 'slow connection', poor: 'poor connection' };

// Who's here, and the leader's moderation controls.
export default function PeoplePanel({ room, tripId, isLeader, active, onInviteCode }) {
  const [error, setError] = useState(null);
  const leaderId = room.leader?.leaderUserId;
  const me = room.me.userId;

  const act = async (event, payload) => {
    const r = await room.send(event, payload);
    setError(r.ok ? null : r.error.message);
  };

  return (
    <section className={`panel ${active ? 'active-tab' : ''}`} data-tab="people" aria-label="People">
      <p className="panel-title">
        <span>People</span>
        {isLeader && (
          <button className="ghost small" onClick={() => act('trip.mod.lockRoom', { locked: !room.trip.roomLocked })}>
            {room.trip.roomLocked ? 'Reopen to new people' : 'Close to new people'}
          </button>
        )}
      </p>
      {room.participants.map((p) => (
        <div key={p.userId} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div className="between">
            <span className="row">
              <span className={`avatar ${p.online ? 'online' : ''}`}>{initials(p.displayName)}</span>
              <span>
                <span style={{ fontSize: 13 }}>{p.displayName}{p.userId === me && ' (you)'}</span>
                <span className="tiny muted" style={{ display: 'block' }}>
                  {p.role}{p.muted && ' · muted'} · {p.online ? QUALITY[p.quality] ?? 'online' : 'offline'}
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
                Make {p.role === 'viewer' ? 'planner' : 'viewer'}
              </button>
              <button className="ghost small" onClick={() => act('trip.mod.mute', { userId: p.userId, muted: !p.muted })}>{p.muted ? 'Unmute' : 'Mute'}</button>
              <button className="ghost small" onClick={() => act('trip.mod.transferLeader', { userId: p.userId })}>Make leader</button>
              <button className="ghost small danger" onClick={() => window.confirm(`Remove ${p.displayName} from the trip? They won't be able to rejoin.`) && act('trip.mod.remove', { userId: p.userId })}>Remove</button>
            </div>
          )}
        </div>
      ))}
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
          New invite code
        </button>
      )}
      {error && <div className="error" role="alert">{error}</div>}
    </section>
  );
}
