import { useMemo, useState } from 'react';
import { IconLock, IconLockOpen, IconTrash } from '@tabler/icons-react';
import { Dialog } from './PinDialog.jsx';
import { dayInfo, money, price } from '../../lib/format.js';
import { useI18n } from '../../lib/i18n.jsx';

// One card: time, who's going and who pays, lock, remove.
export default function ItemDialog({ room, item, names, canPlan, isLeader, onClose }) {
  const { t, lang } = useI18n();
  const locked = item.lifecycleStage === 'locked';
  const voting = item.lifecycleStage === 'voting';
  const editable = canPlan && !locked && !voting;
  const people = room.participants;

  const [dayIndex, setDayIndex] = useState(item.dayIndex);
  const [start, setStart] = useState(item.startTime);
  const [end, setEnd] = useState(item.endTime);
  const [going, setGoing] = useState(item.attendeeIds?.length ? item.attendeeIds : people.map((p) => p.userId));
  const [weighted, setWeighted] = useState(item.split?.type === 'weighted');
  const [weights, setWeights] = useState(() => Object.fromEntries(people.map((p) => [p.userId, item.split?.weights?.[p.userId] ?? 1])));
  const [msg, setMsg] = useState(null);

  // Preview each person's share, in cents, as the server would compute it.
  const preview = useMemo(() => {
    const total = Math.round(item.venue.pricePerPerson * 100) * going.length;
    const w = going.map((id) => (weighted ? Number(weights[id]) || 0 : 1));
    const W = w.reduce((a, b) => a + b, 0);
    if (!W) return null;
    const ids = [...going].sort();
    const base = ids.map((id) => {
      const wi = weighted ? Number(weights[id]) || 0 : 1;
      return { id, c: Math.floor((total * wi) / W), r: (total * wi) % W };
    });
    let left = total - base.reduce((s, b) => s + b.c, 0);
    [...base].sort((a, b) => b.r - a.r || a.id.localeCompare(b.id)).forEach((b) => { if (left > 0 && b.r > 0) { b.c += 1; left -= 1; } });
    return { total: total / 100, shares: Object.fromEntries(base.map((b) => [b.id, b.c / 100])) };
  }, [going, weighted, weights, item.venue.pricePerPerson]);

  const result = (r, ok) => (r.ok ? (setMsg({ ok }), true) : (setMsg({ error: r.error.message }), false));
  const everyone = going.length === people.length;
  const sharing = () => ({
    attendeeIds: everyone ? [] : going,
    split: weighted ? { type: 'weighted', weights: Object.fromEntries(going.map((id) => [id, Number(weights[id]) || 0])) } : { type: 'even' },
  });

  async function saveTime() {
    if (end <= start) return setMsg({ error: t('The end time has to be after the start') });
    result(await room.send('trip.board.move', { itemId: item.itemId, dayIndex: Number(dayIndex), startTime: start, endTime: end, expectedVersion: item.positionVersion }), t('Time saved'));
  }
  async function saveSharing() {
    if (!going.length) return setMsg({ error: t('At least one person has to go') });
    result(await room.send('trip.board.setSharing', { itemId: item.itemId, ...sharing(), expectedVersion: item.positionVersion }), t('Split saved'));
  }
  async function proposeSharing() {
    if (!going.length) return setMsg({ error: t('At least one person has to go') });
    if (result(await room.send('trip.split.propose', { itemId: item.itemId, ...sharing() }), t('Vote opened'))) onClose();
  }

  return (
    <Dialog title={item.venue.name} onClose={onClose}>
      <p className="small muted">
        {t(item.venue.category)} · {item.venue.neighborhood} · {price(item.venue.pricePerPerson)} {t('per person')} · {t('open {hours}', { hours: `${item.venue.hours?.open}–${item.venue.hours?.close}` })}
        {item.venue.dietaryTags?.length > 0 && ` · ${item.venue.dietaryTags.map((d) => t(d)).join(', ')}`}
      </p>
      <p className="small">
        {t('Pinned by {name}', { name: names.get(item.pinnedByUserId) ?? t('someone') })}
        {locked && <> · <IconLock size={12} aria-hidden="true" /> {item.lockedByUserId ? t('locked by {name}', { name: names.get(item.lockedByUserId) ?? t('the leader') }) : t('locked by a vote')}</>}
        {voting && <> · {t('in a vote')}</>}
      </p>

      <h3>{t('When')}</h3>
      <div className="row">
        <div className="field grow">
          <label htmlFor="it-day">{t('Day')}</label>
          <select id="it-day" value={dayIndex} disabled={!editable} onChange={(e) => setDayIndex(e.target.value)}>
            {Array.from({ length: room.trip.dayCount }, (_, d) => <option key={d} value={d}>{t('Day {n}', { n: d + 1 })} · {dayInfo(room.trip.startDate, d, lang).label}</option>)}
          </select>
        </div>
        <div className="field" style={{ width: 140 }}><label htmlFor="it-s">{t('From')}</label><input id="it-s" type="time" value={start} disabled={!editable} onChange={(e) => setStart(e.target.value)} /></div>
        <div className="field" style={{ width: 140 }}><label htmlFor="it-e">{t('To')}</label><input id="it-e" type="time" value={end} disabled={!editable} onChange={(e) => setEnd(e.target.value)} /></div>
      </div>
      {editable && <button onClick={saveTime}>{t('Save time')}</button>}

      <h3 style={{ marginTop: 16 }}>{t("Who's going and who pays")}</h3>
      <table>
        <thead><tr><th>{t('Traveller')}</th><th>{t('Going')}</th>{weighted && <th className="num">{t('Share weight')}</th>}<th className="num">{t('Pays')}</th></tr></thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.userId}>
              <td>{p.displayName}</td>
              <td>
                <input
                  type="checkbox"
                  aria-label={t('{name} is going', { name: p.displayName })}
                  checked={going.includes(p.userId)}
                  disabled={!canPlan || locked || voting}
                  onChange={() => setGoing(going.includes(p.userId) ? going.filter((x) => x !== p.userId) : [...going, p.userId])}
                  style={{ width: 'auto', minHeight: 0 }}
                />
              </td>
              {weighted && (
                <td className="num">
                  <input type="number" min="0" max="100" step="1" aria-label={t('{name} weight', { name: p.displayName })} style={{ width: 70 }} value={weights[p.userId]} disabled={!going.includes(p.userId)} onChange={(e) => setWeights({ ...weights, [p.userId]: e.target.value })} />
                </td>
              )}
              <td className="num">{preview && going.includes(p.userId) ? money(preview.shares[p.userId]) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="between small" style={{ margin: '6px 0 10px' }}>
        <label className="row" style={{ margin: 0, color: 'var(--text)' }}>
          <input type="checkbox" checked={weighted} disabled={!canPlan || locked || voting} onChange={(e) => setWeighted(e.target.checked)} style={{ width: 'auto', minHeight: 0 }} />
          {t('Split by weights (for example a bigger room)')}
        </label>
        {preview && <span className="muted">{t('Total {amount}', { amount: money(preview.total) })}</span>}
      </div>
      {canPlan && !locked && !voting && (
        <div className="row wrap"><button onClick={saveSharing}>{t('Save split')}</button><button onClick={proposeSharing}>{t('Put it to a vote')}</button></div>
      )}

      {msg?.error && <div className="error" role="alert" style={{ marginTop: 10 }}>{msg.error}</div>}
      {msg?.ok && <p className="small muted" style={{ marginTop: 10 }}>{msg.ok}</p>}

      <div className="between" style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div className="row">
          {isLeader && !voting && (
            locked ? (
              <button onClick={async () => result(await room.send('trip.board.unlock', { itemId: item.itemId }), t('Unlocked'))}><IconLockOpen size={14} aria-hidden="true" /> {t('Unlock')}</button>
            ) : (
              <button onClick={async () => result(await room.send('trip.board.lock', { itemId: item.itemId }), t('Locked'))}><IconLock size={14} aria-hidden="true" /> {t('Lock as final')}</button>
            )
          )}
        </div>
        {editable && (
          <button
            className="danger"
            onClick={async () => {
              const r = await room.send('trip.board.remove', { itemId: item.itemId, expectedVersion: item.positionVersion });
              if (result(r, t('Removed'))) onClose();
            }}
          >
            <IconTrash size={14} aria-hidden="true" /> {t('Remove')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
