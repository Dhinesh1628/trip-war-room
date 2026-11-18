import { useEffect, useState } from 'react';
import { IconPin } from '@tabler/icons-react';
import { get } from '../../lib/api.js';
import { price } from '../../lib/format.js';

// "Recommended for your group". Refreshes when the board changes.
export default function IdeasPanel({ tripId, room, active, canPlan, onPin }) {
  const [data, setData] = useState(null);
  const boardKey = Object.keys(room.items).sort().join();

  useEffect(() => {
    const t = setTimeout(() => {
      get(`/trips/${tripId}/recommendations?limit=5`).then(setData).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [tripId, boardKey]);

  return (
    <section className={`panel ${active ? 'active-tab' : ''}`} data-tab="ideas" aria-label="Recommended for your group">
      <p className="panel-title">Recommended for your group</p>
      {!data && <p className="small muted">Loading ideas…</p>}
      {data?.recommendations.map((r) => (
        <div key={r.venueId} className="between" style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
          <div className="grow">
            <div style={{ fontSize: 13, fontWeight: 500 }}>{r.name} <span className="muted" style={{ fontWeight: 400 }}>{price(r.pricePerPerson)}</span></div>
            <div className="tiny muted">{r.why}</div>
          </div>
          {canPlan && (
            <button className="ghost icon" aria-label={`Pin ${r.name}`} title="Pin it" onClick={() => onPin({ venueId: r.venueId, dayIndex: 0 })}>
              <IconPin size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
      {data?.groupDietaryTags?.length > 0 && <p className="tiny faint" style={{ marginTop: 6, marginBottom: 0 }}>Only places that suit: {data.groupDietaryTags.join(', ')}</p>}
    </section>
  );
}
