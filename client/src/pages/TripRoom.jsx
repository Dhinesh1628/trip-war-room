import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { IconAlertTriangle, IconCopy, IconChartBar, IconLock, IconWifiOff, IconCheck } from '@tabler/icons-react';
import { useTripRoom } from '../lib/useTripRoom.js';
import { dateRange, initials, money } from '../lib/format.js';
import Board from './room/Board.jsx';
import VoteBar from './room/VoteBar.jsx';
import PinDialog from './room/PinDialog.jsx';
import ItemDialog from './room/ItemDialog.jsx';
import BudgetPanel from './room/BudgetPanel.jsx';
import ConciergePanel from './room/ConciergePanel.jsx';
import ChatPanel from './room/ChatPanel.jsx';
import PeoplePanel from './room/PeoplePanel.jsx';
import IdeasPanel from './room/IdeasPanel.jsx';
import { get } from '../lib/api.js';

const TABS = [
  ['budget', 'Budget'],
  ['concierge', 'Concierge'],
  ['chat', 'Chat'],
  ['people', 'People'],
  ['ideas', 'Ideas'],
];

export default function TripRoom() {
  const { tripId } = useParams();
  const room = useTripRoom(tripId);
  const [pin, setPin] = useState(null); // { dayIndex, venueId?, startTime? }
  const [openItem, setOpenItem] = useState(null);
  const [tab, setTab] = useState('concierge');
  const [inviteCode, setInviteCode] = useState(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState(null);

  const role = room.me?.role;
  const canPlan = role === 'planner' || role === 'leader' || role === 'admin';
  const isLeader = role === 'leader' || role === 'admin';
  const names = useMemo(() => new Map(room.participants.map((p) => [p.userId, p.displayName])), [room.participants]);

  useEffect(() => {
    if (isLeader) get(`/trips/${tripId}`).then((r) => setInviteCode(r.trip.inviteCode)).catch(() => {});
  }, [isLeader, tripId]);

  // A simultaneous edit lost: say so, briefly.
  useEffect(() => {
    if (!room.rejection) return undefined;
    setNotice(`Someone moved ${room.items[room.rejection.itemId]?.venue?.name ?? 'that card'} first, so it's back where they put it.`);
    const t = setTimeout(() => {
      setNotice(null);
      room.clearRejection();
    }, 5000);
    return () => clearTimeout(t);
  }, [room.rejection]); // eslint-disable-line react-hooks/exhaustive-deps

  if (room.status === 'error') {
    return <main className="page"><div className="banner danger">{room.error}</div><p><Link to="/">Back to your trips</Link></p></main>;
  }
  if (room.status === 'removed') {
    return <main className="page"><div className="banner danger">The trip leader removed you from this trip.</div><p><Link to="/">Back to your trips</Link></p></main>;
  }
  if (!room.trip) return <main className="page muted">Opening the trip room…</main>;

  const t = room.trip;
  const online = room.participants.filter((p) => p.online);
  const conflictItemIds = new Set(room.conflicts.flatMap((c) => c.itemIds));
  const item = openItem ? room.items[openItem] : null;

  return (
    <main className="page stack">
      <div className="room-head">
        <div>
          <h1 style={{ marginBottom: 0 }}>{t.destination}</h1>
          <div className="small muted">
            {dateRange(t.startDate, t.endDate)} · {t.dayCount} days · budget {money(t.totalBudget)}
          </div>
        </div>
        <div className="row wrap">
          <div className="row" aria-label={`${online.length} of ${room.participants.length} online`}>
            {room.participants.map((p) => (
              <span key={p.userId} className={`avatar ${p.online ? 'online' : ''}`} title={`${p.displayName} (${p.role}${p.online ? ', online' : ''})`}>
                {initials(p.displayName)}
              </span>
            ))}
            <span className="small muted">{online.length} online</span>
          </div>
          {t.roomLocked && <span className="tag"><IconLock size={12} aria-hidden="true" /> room closed</span>}
          {inviteCode && (
            <button
              className="tag"
              title="Copy invite link"
              onClick={() => {
                navigator.clipboard?.writeText(`${window.location.origin}/join/${inviteCode}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <IconCheck size={12} aria-hidden="true" /> : <IconCopy size={12} aria-hidden="true" />} {inviteCode}
            </button>
          )}
          <Link className="btn ghost small" to={`/trips/${tripId}/analytics`}><IconChartBar size={16} aria-hidden="true" /> Analytics</Link>
        </div>
      </div>

      {room.status === 'reconnecting' && (
        <div className="banner info" role="status"><IconWifiOff size={16} aria-hidden="true" /> Connection lost. Reconnecting; your board will catch up.</div>
      )}
      {room.leader && !room.leader.connected && (
        <div className="banner info" role="status">
          {names.get(room.leader.leaderUserId) ?? 'The leader'} is away. Locking and unlocking are paused until they're back.
        </div>
      )}
      {room.me.muted && <div className="banner info">The trip leader has muted you in chat.</div>}
      {room.conflicts.map((c) => (
        <div key={c.conflictId} className="banner warn" role="status">
          <IconAlertTriangle size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 1 }} /> <span>{c.details.message}</span>
        </div>
      ))}
      {notice && <div className="banner info" role="status">{notice}</div>}

      <VoteBar room={room} names={names} />

      <div className="room-grid">
        <Board
          room={room}
          canPlan={canPlan}
          conflictItemIds={conflictItemIds}
          names={names}
          onOpen={setOpenItem}
          onAdd={(dayIndex) => setPin({ dayIndex })}
        />

        <aside className="side">
          <div className="tabs" role="tablist" aria-label="Panels">
            {TABS.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'primary' : ''} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>
          <BudgetPanel room={room} names={names} active={tab === 'budget'} />
          <ConciergePanel room={room} active={tab === 'concierge'} canPlan={canPlan} onPin={(p) => setPin(p)} />
          <ChatPanel room={room} active={tab === 'chat'} />
          <PeoplePanel room={room} tripId={tripId} isLeader={isLeader} active={tab === 'people'} onInviteCode={setInviteCode} />
          <IdeasPanel tripId={tripId} room={room} active={tab === 'ideas'} canPlan={canPlan} onPin={(p) => setPin(p)} />
        </aside>
      </div>

      {pin && <PinDialog room={room} initial={pin} onClose={() => setPin(null)} />}
      {item && <ItemDialog room={room} item={item} names={names} canPlan={canPlan} isLeader={isLeader} onClose={() => setOpenItem(null)} />}
    </main>
  );
}
