import { useState } from 'react';
import { IconLock, IconPlus, IconAlertTriangle } from '@tabler/icons-react';
import { dayInfo, price } from '../../lib/format.js';
import Photo from '../../components/Photo.jsx';

// The day-by-day board. Cards can be dragged to another day (same times);
// opening a card lets you change the time, who's going, and more.
export default function Board({ room, canPlan, conflictItemIds, names, onOpen, onAdd, photos }) {
  const [dropDay, setDropDay] = useState(null);
  const [error, setError] = useState(null);
  const items = Object.values(room.items);
  const days = Array.from({ length: room.trip.dayCount }, (_, i) => i);

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

  return (
    <section aria-label="Itinerary">
      {error && <div className="banner danger" role="alert" style={{ marginBottom: 8 }}>{error} <button className="ghost icon" onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}
      <div className="days">
        {days.map((d) => {
          const info = dayInfo(room.trip.startDate, d);
          const dayItems = items.filter((i) => i.dayIndex === d).sort((a, b) => a.startTime.localeCompare(b.startTime) || a.itemId.localeCompare(b.itemId));
          return (
            <div
              key={d}
              className={`day ${dropDay === d ? 'drop' : ''}`}
              onDragOver={(e) => {
                if (!canPlan) return;
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
              <div className="day-head"><span>Day {d + 1} · {info.label}</span><span>{dayItems.length || ''}</span></div>
              {dayItems.map((i) => {
                const locked = i.lifecycleStage === 'locked';
                const voting = i.lifecycleStage === 'voting';
                const draggable = canPlan && !locked && !voting;
                const who = i.attendeeIds?.length ? i.attendeeIds.map((id) => names.get(id)?.split(' ')[0] ?? '?').join(', ') : null;
                return (
                  <div
                    key={i.itemId}
                    className={`card ${locked ? 'locked' : ''} ${voting ? 'voting' : ''} ${conflictItemIds.has(i.itemId) ? 'conflict' : ''}`}
                    draggable={draggable}
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', i.itemId)}
                    onClick={() => onOpen(i.itemId)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(i.itemId))}
                    role="button"
                    tabIndex={0}
                    aria-label={`${i.venue.name}, ${i.startTime} to ${i.endTime}${locked ? ', locked' : ''}${voting ? ', in a vote' : ''}`}
                  >
                    <Photo image={photos?.get(i.venueId)} alt="" className="card-thumb" credit={false} />
                    <div className="card-body">
                    <div className="between">
                      <span className="time">{i.startTime} to {i.endTime}</span>
                      <span className="row" style={{ gap: 4 }}>
                        {conflictItemIds.has(i.itemId) && <IconAlertTriangle size={14} color="var(--warn-border)" aria-hidden="true" />}
                        {locked && <IconLock size={14} color="var(--text-2)" aria-hidden="true" />}
                        {voting && <span className="tag accent">vote</span>}
                      </span>
                    </div>
                    <div className="name">{i.venue.name}</div>
                    <div className="small muted">
                      {price(i.venue.pricePerPerson)} pp · {who ? `${who} only` : i.venue.neighborhood}
                      {i.split?.type === 'weighted' && ' · weighted'}
                    </div>
                    </div>
                  </div>
                );
              })}
              {canPlan && (
                <button className="add-slot" onClick={() => onAdd(d)}>
                  <IconPlus size={14} aria-hidden="true" /> Pin a venue
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="tiny faint" style={{ margin: '4px 0 0' }}>
        {canPlan ? 'Drag a card to another day, or open it to change the time or who is going.' : 'You can view and vote. Ask the leader if you want to plan.'}
      </p>
    </section>
  );
}
