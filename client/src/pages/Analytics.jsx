import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { IconArrowLeft, IconCircleCheck, IconAlertTriangle } from '@tabler/icons-react';
import { get } from '../lib/api.js';
import { money } from '../lib/format.js';
import { useI18n } from '../lib/i18n.jsx';

export default function Analytics() {
  const { tripId } = useParams();
  const { t } = useI18n();
  const [a, setA] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    get(`/trips/${tripId}/analytics`).then(setA).catch((e) => setError(e.message));
  }, [tripId]);

  if (error) return <main className="page"><div className="banner danger">{error}</div></main>;
  if (!a) return <main className="page muted">{t('Counting the session…')}</main>;

  const metrics = [
    ['Planning time', t('{n} min', { n: a.planning.durationMinutes })],
    ['Most online at once', a.peakConcurrentPlanners],
    ['Concierge questions', a.concierge.questions],
    ['Conflicts flagged', a.conflicts.flagged],
    ['Conflicts resolved', a.conflicts.resolved],
    ['Votes held', a.votes.resolved],
  ];
  const people = a.finalBudget.perPerson;
  const row = (label, value) => <div className="list-row"><span className="muted">{t(label)}</span><span>{value}</span></div>;

  return (
    <main className="page stack">
      <Link to={`/trips/${tripId}`} className="small row" style={{ gap: 4 }}><IconArrowLeft size={14} aria-hidden="true" /> {t('Back to the board')}</Link>
      <h1>{t('Session analytics')} · {a.destination}</h1>
      <div className={`banner ${a.reconciliation.reconciled ? 'info' : 'warn'}`}>
        {a.reconciliation.reconciled ? <IconCircleCheck size={16} aria-hidden="true" /> : <IconAlertTriangle size={16} aria-hidden="true" />}
        <span>
          {a.reconciliation.reconciled
            ? t("Every number here comes from the trip's {n} logged events, and replaying them gives exactly the board you have now.", { n: a.eventCount })
            : t("The event log doesn't match the board for {n} item(s).", { n: a.reconciliation.differences.length })}
        </span>
      </div>

      <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
        {metrics.map(([label, value]) => (
          <div key={label} className="metric"><div className="small muted">{t(label)}</div><div className="v">{value}</div></div>
        ))}
      </div>

      <section className="panel">
        <h2>{t('Final cost per person')}</h2>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>{t('Item')}</th>
                <th>{t('Split')}</th>
                {people.map((p) => <th key={p.userId} className="num">{p.displayName}</th>)}
                <th className="num">{t('Total')}</th>
              </tr>
            </thead>
            <tbody>
              {a.finalBudget.items.map((i) => (
                <tr key={i.itemId}>
                  <td>{t('Day {n}', { n: i.dayIndex + 1 })} · {i.startTime} · {i.name}</td>
                  <td className="muted">{t(i.split)}</td>
                  {people.map((p) => <td key={p.userId} className="num">{i.shares[p.userId] != null ? money(i.shares[p.userId]) : '—'}</td>)}
                  <td className="num">{money(i.total)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ fontWeight: 500 }}>{t('Total')}</td>
                <td />
                {people.map((p) => <td key={p.userId} className="num" style={{ fontWeight: 500 }}>{money(p.total)}</td>)}
                <td className="num" style={{ fontWeight: 500 }}>{money(a.finalBudget.groupTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
          {t('budget {amount}', { amount: money(a.finalBudget.totalBudget) })} ·{' '}
          {a.finalBudget.remaining >= 0 ? t('{amount} left', { amount: money(a.finalBudget.remaining) }) : t('{amount} over', { amount: money(-a.finalBudget.remaining) })}
        </p>
      </section>

      <section className="two-col">
        <div className="panel small">
          <p className="panel-title">{t('Board activity')}</p>
          {row('Pinned', a.board.pinned)}
          {row('Moved', a.board.moved)}
          {row('Removed', a.board.removed)}
          {row('Locked', a.board.locked)}
          {row('On the board now', a.board.finalItemCount)}
        </div>
        <div className="panel small">
          <p className="panel-title">{t('Talk and decisions')}</p>
          {row('Chat messages', a.chatMessages)}
          {row('Ballots cast', a.votes.ballots)}
          {row('Slot votes', a.votes.byKind.slot ?? 0)}
          {row('Budget-split votes', a.votes.byKind.split ?? 0)}
          {row('Conflicts still open', a.conflicts.stillOpen)}
        </div>
      </section>
    </main>
  );
}
