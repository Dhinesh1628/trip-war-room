import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { IconAlertTriangle, IconCopy, IconChartBar, IconLock, IconWifiOff, IconCheck, IconArrowLeft } from '@tabler/icons-react';
import { useTripRoom } from '../lib/useTripRoom.js';
import { dateRange, initials, money } from '../lib/format.js';
import { useI18n } from '../lib/i18n.jsx';
import { saveBoard, loadBoard } from '../lib/offline.js';
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
import { useCatalog, findDestination } from '../lib/catalog.js';
import Photo from '../components/Photo.jsx';

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
  const { t, lang } = useI18n();
  const { catalog } = useCatalog();
  const [pin, setPin] = useState(null); // { dayIndex, venueId?, startTime? }
  const [openItem, setOpenItem] = useState(null);
  const [tab, setTab] = useState('concierge');
  const [inviteCode, setInviteCode] = useState(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState(null);
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && navigator.onLine === false);

  const role = room.me?.role;
  const canPlan = role === 'planner' || role === 'leader' || role === 'admin';
  const isLeader = role === 'leader' || role === 'admin';
  const names = useMemo(() => new Map(room.participants.map((p) => [p.userId, p.displayName])), [room.participants]);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Keep a read-only copy of the live board for offline viewing (at most every 2 s).
  const lastSave = useRef(0);
  useEffect(() => {
    if (room.status !== 'live' || !room.trip) return undefined;
    const wait = Math.max(0, 2000 - (Date.now() - lastSave.current));
    const timer = setTimeout(() => {
      lastSave.current = Date.now();
      saveBoard(tripId, room);
    }, wait);
    return () => clearTimeout(timer);
  }, [room.status, room.trip, room.items, room.participants, room.budget]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isLeader) get(`/trips/${tripId}`).then((r) => setInviteCode(r.trip.inviteCode)).catch(() => {});
  }, [isLeader, tripId]);

  // A simultaneous edit lost: say so, briefly.
  useEffect(() => {
    if (!room.rejection) return undefined;
    setNotice(t("Someone moved {name} first, so it's back where they put it.", { name: room.items[room.rejection.itemId]?.venue?.name ?? t('that card') }));
    const timer = setTimeout(() => {
      setNotice(null);
      room.clearRejection();
    }, 5000);
    return () => clearTimeout(timer);
  }, [room.rejection]); // eslint-disable-line react-hooks/exhaustive-deps

  const dest = findDestination(catalog, room.trip?.destinationSlug) ?? findDestination(catalog, room.trip?.destination);
  const photos = useMemo(() => new Map((catalog?.venues ?? []).map((v) => [v.venueId, v.image])), [catalog]);

  if (room.status === 'removed') {
    return <main className="page"><div className="banner danger">{t('The trip leader removed you from this trip.')}</div><p><Link to="/trips">{t('Back to your trips')}</Link></p></main>;
  }
  // No live board (offline, or the server can't be reached): show the saved copy.
  if (!room.trip && (offline || room.status === 'error' || room.status === 'reconnecting')) {
    const snap = loadBoard(tripId);
    if (snap) return <OfflineBoard snap={snap} photos={photos} />;
    if (room.status === 'error' || offline) {
      return (
        <main className="page">
          <div className="banner danger">{offline ? t("You're offline and this trip hasn't been saved on this device yet.") : room.error}</div>
          <p><Link to="/trips">{t('Back to your trips')}</Link></p>
        </main>
      );
    }
  }
  if (room.status === 'error') {
    return <main className="page"><div className="banner danger">{room.error}</div><p><Link to="/trips">{t('Back to your trips')}</Link></p></main>;
  }
  if (!room.trip) return <main className="page muted">{t('Opening the trip room…')}</main>;

  const trip = room.trip;
  const online = room.participants.filter((p) => p.online);
  const conflictItemIds = new Set(room.conflicts.flatMap((c) => c.itemIds));
  const item = openItem ? room.items[openItem] : null;

  return (
    <main className="page stack">
      <Link to="/trips" className="small muted row" style={{ textDecoration: 'none', gap: 4 }}><IconArrowLeft size={14} aria-hidden="true" /> {t('Trips')}</Link>
      <Photo image={dest?.image} alt="" className="room-hero" eager>
        <div className="hero-shade" aria-hidden="true" />
        <div className="room-hero-text">
          <div>
            <h1>{trip.destination}</h1>
            <div className="small on-photo">
              {dateRange(trip.startDate, trip.endDate, lang)} · {t('{n} days', { n: trip.dayCount })} · {t('budget {amount}', { amount: money(trip.totalBudget) })}
            </div>
          </div>
          <div className="row wrap on-photo">
            <div className="row" aria-label={t('{online} of {total} online', { online: online.length, total: room.participants.length })}>
              {room.participants.map((p) => (
                <span key={p.userId} className={`avatar ${p.online ? 'online' : ''}`} title={`${p.displayName} (${t(p.role)}${p.online ? `, ${t('online')}` : ''})`}>
                  {initials(p.displayName)}
                </span>
              ))}
              <span className="small">{t('{n} online', { n: online.length })}</span>
            </div>
            {trip.roomLocked && <span className="tag"><IconLock size={12} aria-hidden="true" /> {t('room closed')}</span>}
            {inviteCode && (
              <button
                className="tag"
                title={t('Copy invite link')}
                aria-label={t('Copy invite link')}
                onClick={() => {
                  navigator.clipboard?.writeText(`${window.location.origin}/join/${inviteCode}`);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <IconCheck size={12} aria-hidden="true" /> : <IconCopy size={12} aria-hidden="true" />} {copied ? t('Copied') : inviteCode}
              </button>
            )}
            <Link className="btn small" to={`/trips/${tripId}/analytics`}><IconChartBar size={16} aria-hidden="true" /> {t('Analytics')}</Link>
          </div>
        </div>
      </Photo>

      {room.status === 'reconnecting' && (
        <div className="banner info" role="status"><IconWifiOff size={16} aria-hidden="true" /> {t('Connection lost. Reconnecting; your board will catch up.')}</div>
      )}
      {room.leader && !room.leader.connected && (
        <div className="banner info" role="status">
          {t("{name} is away. Locking and unlocking are paused until they're back.", { name: names.get(room.leader.leaderUserId) ?? t('The leader') })}
        </div>
      )}
      {room.me.muted && <div className="banner info">{t('The trip leader has muted you in chat.')}</div>}
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
          photos={photos}
        />

        <aside className="side">
          <div className="tabs" role="tablist" aria-label={t('Panels')}>
            {TABS.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'primary' : ''} onClick={() => setTab(key)}>{t(label)}</button>
            ))}
          </div>
          <BudgetPanel room={room} names={names} active={tab === 'budget'} />
          <ConciergePanel room={room} active={tab === 'concierge'} canPlan={canPlan} onPin={(p) => setPin(p)} />
          <ChatPanel room={room} active={tab === 'chat'} />
          <PeoplePanel room={room} tripId={tripId} isLeader={isLeader} active={tab === 'people'} onInviteCode={setInviteCode} />
          <IdeasPanel tripId={tripId} room={room} active={tab === 'ideas'} canPlan={canPlan} onPin={(p) => setPin(p)} />
        </aside>
      </div>

      {pin && <PinDialog room={room} initial={pin} onClose={() => setPin(null)} photos={photos} />}
      {item && <ItemDialog room={room} item={item} names={names} canPlan={canPlan} isLeader={isLeader} onClose={() => setOpenItem(null)} />}
    </main>
  );
}

// The saved copy of a board, shown without a connection.
function OfflineBoard({ snap, photos }) {
  const { t, lang } = useI18n();
  const names = new Map(snap.participants.map((p) => [p.userId, p.displayName]));
  const view = { ...snap, send: async () => ({ ok: false, error: { message: t('You are offline') } }) };
  const when = new Date(snap.savedAt).toLocaleString(lang === 'en' ? 'en-IN' : `${lang}-IN`, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <main className="page stack">
      <Link to="/trips" className="small muted row" style={{ textDecoration: 'none', gap: 4 }}><IconArrowLeft size={14} aria-hidden="true" /> {t('Trips')}</Link>
      <div className="banner warn" role="status">
        <IconWifiOff size={16} aria-hidden="true" style={{ flex: 'none' }} />
        <span>{t('Offline: showing your last saved board ({when}). It updates when you are back online.', { when })}</span>
      </div>
      <h1 style={{ margin: 0 }}>{snap.trip.destination}</h1>
      <div className="small muted">{dateRange(snap.trip.startDate, snap.trip.endDate, lang)} · {t('budget {amount}', { amount: money(snap.trip.totalBudget) })}</div>
      <Board room={view} canPlan={false} readOnly conflictItemIds={new Set()} names={names} onOpen={() => {}} onAdd={() => {}} photos={photos} />
    </main>
  );
}
