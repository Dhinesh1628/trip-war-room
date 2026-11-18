import { useState } from 'react';
import { IconSparkles, IconPin } from '@tabler/icons-react';
import { price } from '../../lib/format.js';

// Ask the Concierge. Answers are picked by the rules and cite their sources;
// the wording is from Claude, a local model, or a fixed template.
export default function ConciergePanel({ room, active, canPlan, onPin }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [answer, setAnswer] = useState(null);

  async function ask(e) {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 3) return setError('Ask something a little longer, like "vegan lunch under $20"');
    setBusy(true);
    setError(null);
    const r = await room.send('trip.ai.ask', { question: q });
    setBusy(false);
    if (r.ok) {
      setAnswer(r.result);
      setQuestion('');
    } else setError(r.error.message);
  }

  const a = answer;
  const anchorDay = a?.constraints?.anchor?.dayIndex;
  return (
    <section className={`panel ${active ? 'active-tab' : ''}`} data-tab="concierge" aria-label="Concierge">
      <p className="panel-title"><span className="row" style={{ gap: 4 }}><IconSparkles size={14} aria-hidden="true" /> Concierge</span></p>
      <form onSubmit={ask} noValidate>
        <textarea
          rows={2}
          aria-label="Ask the Concierge"
          placeholder="Vegetarian dinner near our 5 PM tour under $25"
          value={question}
          onChange={(e) => { setQuestion(e.target.value); setError(null); }}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && ask(e)}
        />
        {error && <div className="error" role="alert">{error}</div>}
        <button style={{ marginTop: 6 }} disabled={busy}>{busy ? 'Thinking…' : 'Ask'}</button>
      </form>

      {a && (
        <div style={{ marginTop: 12 }}>
          <div className="small" style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '6px 8px', marginBottom: 8 }}>{a.question}</div>
          <p className="voice" aria-live="polite">{a.answer}</p>
          {a.sources.length > 0 && (
            <div className="row wrap" style={{ gap: 4 }}>
              {a.sources.map((s) => <span key={s.venueId} className="tag">{s.name} · {price(s.pricePerPerson)}</span>)}
            </div>
          )}
          <div className="between" style={{ marginTop: 8 }}>
            {canPlan && a.suggestedVenueId ? (
              <button
                onClick={() =>
                  onPin({
                    venueId: a.suggestedVenueId,
                    dayIndex: anchorDay ?? 0,
                    startTime: a.constraints.mustBeOpen?.from,
                  })
                }
              >
                <IconPin size={14} aria-hidden="true" /> Pin it
              </button>
            ) : <span />}
            <span className="tiny faint">
              {a.mode === 'no_match' ? 'no venue fits every rule' : `rules checked · ${a.sources.length} sources · ${a.mode === 'llm' ? 'AI-worded' : 'template'}`}
            </span>
          </div>
        </div>
      )}
      {!a && <p className="tiny faint" style={{ marginTop: 8, marginBottom: 0 }}>Every suggestion obeys the group's budget, dietary needs, opening hours and distance.</p>}
    </section>
  );
}
