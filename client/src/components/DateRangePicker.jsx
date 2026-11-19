import { useEffect, useMemo, useRef, useState } from 'react';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useI18n } from '../lib/i18n.jsx';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromIso = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const MAX_TRIP_DAYS = 30;

// Pick a start and an end date on a month calendar. First click sets the
// start, second the end (an earlier day restarts). Days before today are off.
export function useRangeLabel(start, end) {
  const { lang } = useI18n();
  return useMemo(() => {
    const f = (s) => fromIso(s).toLocaleDateString(lang === 'en' ? 'en-IN' : `${lang}-IN`, { weekday: 'short', day: 'numeric', month: 'short' });
    if (!start) return null;
    if (!end) return f(start);
    const days = Math.round((fromIso(end) - fromIso(start)) / 86400000) + 1;
    return { text: `${f(start)} – ${f(end)}`, days };
  }, [start, end, lang]);
}

export default function DateRangePicker({ start, end, onChange, onClose }) {
  const { t, lang } = useI18n();
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const [month, setMonth] = useState(() => {
    const base = start ? fromIso(start) : today;
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const ref = useRef(null);

  useEffect(() => {
    ref.current?.querySelector('button[data-focus="true"]')?.focus();
    const esc = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const locale = lang === 'en' ? 'en-IN' : `${lang}-IN`;
  const title = month.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  const lead = (month.getDay() + 6) % 7; // Monday first
  const daysIn = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: daysIn }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: 'narrow' }));

  function pick(d) {
    const s = iso(d);
    if (!start || end || s < start) return onChange({ start: s, end: '' });
    const days = Math.round((d - fromIso(start)) / 86400000) + 1;
    if (days > MAX_TRIP_DAYS) return onChange({ start: s, end: '' });
    onChange({ start, end: s });
    onClose?.();
  }

  const canBack = month > new Date(today.getFullYear(), today.getMonth(), 1);
  return (
    <div className="calendar" ref={ref} role="dialog" aria-label={t('Pick your dates')}>
      <div className="between cal-head">
        <button type="button" className="round-btn" disabled={!canBack} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label={t('Previous month')}>
          <IconChevronLeft size={16} aria-hidden="true" />
        </button>
        <span className="cal-title" aria-live="polite">{title}</span>
        <button type="button" className="round-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label={t('Next month')}>
          <IconChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="cal-grid" role="grid">
        {weekdays.map((w, i) => <span key={`w${i}`} className="cal-wd" aria-hidden="true">{w}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} />;
          const s = iso(d);
          const past = d < today;
          const isStart = s === start;
          const isEnd = s === end;
          const inRange = start && end && s > start && s < end;
          return (
            <button
              key={s}
              type="button"
              className={`cal-day ${isStart || isEnd ? 'sel' : ''} ${inRange ? 'mid' : ''}`}
              disabled={past}
              aria-pressed={isStart || isEnd}
              aria-label={d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              data-focus={isStart || (!start && s === iso(today)) ? 'true' : undefined}
              onClick={() => pick(d)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="between small" style={{ marginTop: 8 }}>
        <span className="muted">{!start ? t('Pick a start date') : !end ? t('Pick an end date') : ''}</span>
        {(start || end) && <button type="button" className="ghost small" onClick={() => onChange({ start: '', end: '' })}>{t('Clear dates')}</button>}
      </div>
    </div>
  );
}
