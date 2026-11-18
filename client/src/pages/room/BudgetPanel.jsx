import { money } from '../../lib/format.js';

export default function BudgetPanel({ room, names, active }) {
  const b = room.budget;
  if (!b) return null;
  const pct = b.totalBudget ? Math.min(100, Math.round((b.groupCommitted / b.totalBudget) * 100)) : 0;
  return (
    <section className={`panel ${active ? 'active-tab' : ''}`} data-tab="budget" aria-label="Budget">
      <p className="panel-title">Budget</p>
      <div className="between" style={{ alignItems: 'baseline' }}>
        <span style={{ fontSize: 20, fontWeight: 500 }}>{money(b.groupCommitted)}</span>
        <span className="small muted">of {money(b.totalBudget)} · {b.remaining >= 0 ? `${money(b.remaining)} left` : `${money(-b.remaining)} over`}</span>
      </div>
      <div className={`bar ${b.overBudget ? 'over' : ''}`} style={{ margin: '8px 0 10px' }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used">
        <div style={{ width: `${pct}%` }} />
      </div>
      {(b.perPerson ?? []).map((p) => (
        <div key={p.userId} className="list-row" style={p.overCeiling ? { color: 'var(--danger)' } : undefined}>
          <span>{names.get(p.userId) ?? 'Traveller'}</span>
          <span>
            {money(p.committed)}
            {p.ceiling != null && <span className={p.overCeiling ? '' : 'muted'}> of {money(p.ceiling)}</span>}
          </span>
        </div>
      ))}
      <p className="tiny faint" style={{ marginTop: 6, marginBottom: 0 }}>Exact to the cent. Open a card to change who's going or how it's split.</p>
    </section>
  );
}
