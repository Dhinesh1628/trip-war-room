import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { IconArrowLeft, IconCircleCheck, IconAlertTriangle } from '@tabler/icons-react';
import { get } from '../lib/api.js';
import { money } from '../lib/format.js';

export default function Analytics() {
  const { tripId } = useParams();
  const [a, setA] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    get(`/trips/${tripId}/analytics`).then(setA).catch((e) => setError(e.message));
  }, [tripId]);

  if (error) return <main className="page"><div className="banner danger">{error}</div></main>;
  if (!a) return <main className="page muted">Counting the session…</main>;

  const metrics = [
    ['Planning time', `${a.planning.durationMinutes} min`],
    ['Most online at once', a.peakConcurrentPlanners],
    ['Concierge questions', a.concierge.questions],
    ['Conflicts flagged', a.conflicts.flagged],
    ['Conflicts resolved', a.conflicts.resolved],
    ['Votes held', a.votes.resolved],
  ];
  const people = a.finalBudget.perPerson;

  return (
    <main className="page stack">
      <Link to={`/trips/${tripId}`} className="small row" style={{ gap: 4 }}><IconArrowLeft size={14} aria-hidden="true" /> Back to the board</Link>
      <h1>Session analytics · {a.destination}</h1>
      <div className={`banner ${a.reconciliation.reconciled ? 'info' : 'warn'}`}>
        {a.reconciliation.reconciled ? <IconCircleCheck size={16} aria-hidden="true" /> : <IconAlertTriangle size={16} aria-hidden="true" />}
        <span>
          {a.reconciliation.reconciled
            ? `Every number here comes from the trip's ${a.eventCount} logged events, and replaying them gives exactly the board you have now.`
            : `The event log doesn't match the board for ${a.reconciliation.differences.length} item(s).`}
        </span>
      </div>

      <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
        {metrics.map(([label, value]) => (
          <div key={label} className="metric"><div className="small muted">{label}</div><div className="v">{value}</div></div>
        ))}
      </div>

      <section className="panel">
        <h2>Final cost per person</h2>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Split</th>
                {people.map((p) => <th key={p.userId} className="num">{p.displayName}</th>)}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {a.finalBudget.items.map((i) => (
                <tr key={i.itemId}>
                  <td>Day {i.dayIndex + 1} · {i.startTime} · {i.name}</td>
                  <td className="muted">{i.split}</td>
                  {people.map((p) => <td key={p.userId} className="num">{i.shares[p.userId] != null ? money(i.shares[p.userId]) : '—'}</td>)}
                  <td className="num">{money(i.total)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ fontWeight: 500 }}>Total</td>
                <td />
                {people.map((p) => <td key={p.userId} className="num" style={{ fontWeight: 500 }}>{money(p.total)}</td>)}
                <td className="num" style={{ fontWeight: 500 }}>{money(a.finalBudget.groupTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
          Budget {money(a.finalBudget.totalBudget)} · {a.finalBudget.remaining >= 0 ? `${money(a.finalBudget.remaining)} left` : `${money(-a.finalBudget.remaining)} over`}
        </p>
      </section>

      <section className="two-col">
        <div className="panel small">
          <p className="panel-title">Board activity</p>
          <div className="list-row"><span className="muted">Pinned</span><span>{a.board.pinned}</span></div>
          <div className="list-row"><span className="muted">Moved</span><span>{a.board.moved}</span></div>
          <div className="list-row"><span className="muted">Removed</span><span>{a.board.removed}</span></div>
          <div className="list-row"><span className="muted">Locked</span><span>{a.board.locked}</span></div>
          <div className="list-row"><span className="muted">On the board now</span><span>{a.board.finalItemCount}</span></div>
        </div>
        <div className="panel small">
          <p className="panel-title">Talk and decisions</p>
          <div className="list-row"><span className="muted">Chat messages</span><span>{a.chatMessages}</span></div>
          <div className="list-row"><span className="muted">Ballots cast</span><span>{a.votes.ballots}</span></div>
          <div className="list-row"><span className="muted">Slot votes</span><span>{a.votes.byKind.slot ?? 0}</span></div>
          <div className="list-row"><span className="muted">Budget-split votes</span><span>{a.votes.byKind.split ?? 0}</span></div>
          <div className="list-row"><span className="muted">Conflicts still open</span><span>{a.conflicts.stillOpen}</span></div>
        </div>
      </section>
    </main>
  );
}
