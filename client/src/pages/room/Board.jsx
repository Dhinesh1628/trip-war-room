import { useEffect, useRef, useState } from 'react';
import { IconLock, IconPlus, IconAlertTriangle, IconGripVertical } from '@tabler/icons-react';
import { dayInfo, price } from '../../lib/format.js';
import { useI18n } from '../../lib/i18n.jsx';
import Photo from '../../components/Photo.jsx';

// The day-by-day board. Cards move to another day (same times) by dragging:
// with a mouse, drag the card; on a touch screen, press and drag its grip.
// Opening a card lets you change the time, who's going, and more (also the
// keyboard route for moving a card).
export default function Board({ room, canPlan, conflictItemIds, names, onOpen, onAdd, photos, readOnly = false }) {
  const { t, lang } = useI18n();
  const [dropDay, setDropDay] = useState(null);
  const [error, setError] = useState(null);
  const [touchDrag, setTouchDrag] = useState(null); // { itemId, name, x, y }
  const daysRef = useRef(null);
  const items = Object.values(room.items);
  const days = Array.from({ length: room.trip.dayCount }, (_, i) => i);
  const editable = canPlan && !readOnly;

  async function moveToDay(itemId, dayIndex) {
    const item = room.items[itemId];
    if (!item || item.dayIndex === dayIndex) return;
    const r = await room.send('trip.board.move', {
      itemId,
      dayIndex,
      startTime: item.startTime,
      endTime: item.endTime,
      expectedVersion: item.positionVersion,
    });
    if (!r.ok && r.error.code !== 'VERSION_CONFLICT') setError(r.error.message);
  }

  // ---- touch dragging (pointer events on the grip) ----
  const dayAt = (x, y) => {
    const el = document.elementFromPoint(x, y)?.closest('[data-day]');
    return el ? Number(el.dataset.day) : null;
  };
  useEffect(() => {
    if (!touchDrag) return undefined;
    let raf = null;
    const move = (e) => {
      e.preventDefault();
      setTouchDrag((d) => d && { ...d, x: e.clientX, y: e.clientY });
      setDropDay(dayAt(e.clientX, e.clientY));
      // Scroll the days sideways when the finger nears an edge.
      const box = daysRef.current?.getBoundingClientRect();
      cancelAnimationFrame(raf);
      if (box) {
        const edge = 40;
        const dx = e.clientX < box.left + edge ? -12 : e.clientX > box.right - edge ? 12 : 0;
        if (dx) {
          const step = () => {
            daysRef.current.scrollLeft += dx;
            raf = requestAnimationFrame(step);
          };
          raf = requestAnimationFrame(step);
        }
      }
    };
    const end = (e) => {
      cancelAnimationFrame(raf);
      const day = dayAt(e.clientX, e.clientY);
      const id = touchDrag.itemId;
      setTouchDrag(null);
      setDropDay(null);
      if (day != null && e.type === 'pointerup') moveToDay(id, day);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [touchDrag?.itemId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section aria-label={t('Itinerary')}>
      {error && <div className="banner danger" role="alert" style={{ marginBottom: 8 }}>{error} <button className="ghost icon" onClick={() => setError(null)} aria-label={t('Dismiss')}>×</button></div>}
      <div className="days" ref={daysRef}>
        {days.map((d) => {
          const info = dayInfo(room.trip.startDate, d, lang);
          const dayItems = items.filter((i) => i.dayIndex === d).sort((a, b) => a.startTime.localeCompare(b.startTime) || a.itemId.localeCompare(b.itemId));
          return (
            <div
              key={d}
              data-day={d}
              className={`day ${dropDay === d ? 'drop' : ''}`}
              onDragOver={(e) => {
                if (!editable) return;
                e.preventDefault();
                setDropDay(d);
              }}
              onDragLeave={() => setDropDay(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDropDay(null);
                moveToDay(e.dataTransfer.getData('text/plain'), d);
              }}
            >
              <div className="day-head"><span>{t('Day {n}', { n: d + 1 })} · {info.label}</span><span>{dayItems.length || ''}</span></div>
              {dayItems.map((i) => {
                const locked = i.lifecycleStage === 'locked';
                const voting = i.lifecycleStage === 'voting';
                const draggable = editable && !locked && !voting;
                const who = i.attendeeIds?.length ? i.attendeeIds.map((id) => names.get(id)?.split(' ')[0] ?? '?').join(', ') : null;
                return (
                  <div
                    key={i.itemId}
                    className={`card ${locked ? 'locked' : ''} ${voting ? 'voting' : ''} ${conflictItemIds.has(i.itemId) ? 'conflict' : ''} ${touchDrag?.itemId === i.itemId ? 'lifting' : ''}`}
                    draggable={draggable}
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', i.itemId)}
                    onClick={() => onOpen(i.itemId)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(i.itemId))}
                    role="button"
                    tabIndex={0}
                    aria-label={`${i.venue.name}, ${i.startTime}–${i.endTime}${locked ? `, ${t('locked')}` : ''}${voting ? `, ${t('in a vote')}` : ''}`}
                  >
                    <Photo image={photos?.get(i.venueId)} alt="" className="card-thumb" credit={false} label={false} />
                    <div className="card-body">
                      <div className="between">
                        <span className="time">{i.startTime}–{i.endTime}</span>
                        <span className="row" style={{ gap: 4 }}>
                          {conflictItemIds.has(i.itemId) && <IconAlertTriangle size={14} color="var(--warn-border)" aria-hidden="true" />}
                          {locked && <IconLock size={14} color="var(--text-2)" aria-hidden="true" />}
                          {voting && <span className="tag accent">{t('vote')}</span>}
                          {draggable && (
                            <span
                              className="drag-handle"
                              aria-hidden="true"
                              title={t('Press and drag to move')}
                              onClick={(e) => e.stopPropagation()}
                              onPointerDown={(e) => {
                                if (e.pointerType === 'mouse') return; // mice use normal drag and drop
                                e.preventDefault();
                                e.stopPropagation();
                                setTouchDrag({ itemId: i.itemId, name: i.venue.name, x: e.clientX, y: e.clientY });
                              }}
                            >
                              <IconGripVertical size={18} />
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="name">{i.venue.name}</div>
                      <div className="small muted">
                        {price(i.venue.pricePerPerson)} {t('pp')} · {who ? t('{names} only', { names: who }) : i.venue.neighborhood}
                        {i.split?.type === 'weighted' && ` · ${t('weighted')}`}
                      </div>
                    </div>
                  </div>
                );
              })}
              {editable && (
                <button className="add-slot" onClick={() => onAdd(d)}>
                  <IconPlus size={14} aria-hidden="true" /> {t('Pin a venue')}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {touchDrag && (
        <div className="drag-ghost" style={{ left: touchDrag.x, top: touchDrag.y }} aria-hidden="true">{touchDrag.name}</div>
      )}
      <p className="tiny faint" style={{ margin: '4px 0 0' }}>
        {readOnly
          ? t('Offline: this is your last saved board. Changes need a connection.')
          : editable
            ? t('Drag a card to another day (on a phone, press and drag its grip), or open it to change the time or who is going.')
            : t('You can view and vote. Ask the leader if you want to plan.')}
      </p>
    </section>
  );
}
