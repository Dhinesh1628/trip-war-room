import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { IconPlus, IconTicket, IconCompass, IconHeart, IconUser, IconShieldLock, IconUsers, IconAlertCircle, IconArrowRight } from '@tabler/icons-react';
import { get } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { useCatalog, findDestination } from '../lib/catalog.js';
import { cityOf, price, shortRange } from '../lib/format.js';
import Photo from '../components/Photo.jsx';
import TripCard from '../components/TripCard.jsx';
import { JoinDialog } from '../components/Shell.jsx';

const ACTIVITY = {
  item_pinned: '{who} pinned {place}',
  item_locked: '{who} locked {place}',
  item_removed: '{who} removed {place}',
  vote_resolved: 'A vote closed',
  ai_asked: '{who} asked the Concierge',
  conflict_opened: 'A clash was flagged',
};

function greeting(t) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  return h < 12 ? t('Good morning') : h < 17 ? t('Good afternoon') : t('Good evening');
}

function ago(iso, t) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return t('just now');
  if (m < 60) return t('{n} min ago', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('{n} h ago', { n: h });
  const d = Math.round(h / 24);
  return d === 1 ? t('yesterday') : t('{n} days ago', { n: d });
}

// The signed-in home page: summary numbers, the next trip, invitations,
// recent activity and quick links.
export default function HomePage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { catalog } = useCatalog();
  const [home, setHome] = useState(null);
  const [trips, setTrips] = useState(null);
  const [error, setError] = useState(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    Promise.all([get('/users/me/home'), get('/users/me/dashboard')])
      .then(([h, d]) => {
        setHome(h);
        setTrips([...d.trips.led, ...d.trips.joined]);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <main className="page"><div className="banner danger">{error}</div></main>;
  const first = user?.displayName?.split(' ')[0] ?? '';
  const next = home?.nextTrip;
  const subtitle = next
    ? next.daysToGo > 1
      ? t('Your {city} trip starts in {n} days', { city: cityOf(next.destination), n: next.daysToGo })
      : next.daysToGo === 1
        ? t('Your {city} trip starts tomorrow', { city: cityOf(next.destination) })
        : t('Your {city} trip is on now', { city: cityOf(next.destination) })
    : t('Plan your next trip in India with your group.');

  return (
    <main className="page home">
      <div className="section-head" style={{ alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0 }}>{greeting(t)}, {first}</h1>
          <p className="small muted" style={{ margin: 0 }}>{subtitle}</p>
        </div>
        <div className="row">
          <button className="pill-btn" onClick={() => setJoining(true)}><IconTicket size={16} aria-hidden="true" /> {t('Join with code')}</button>
          <Link className="pill-btn dark" to="/explore"><IconPlus size={16} aria-hidden="true" /> {t('Plan a trip')}</Link>
        </div>
      </div>

      {!home && <p className="muted">{t('Loading your dashboard…')}</p>}
      {home && (
        <>
          <div className="stat-grid" role="list">
            <Stat label={t('Upcoming trips')} value={home.stats.upcomingTrips} />
            <Stat label={t('Planned spend')} value={price(home.stats.plannedSpend, home.stats.currency)} hint={t('your share')} />
            <Stat label={t('Saved places')} value={home.stats.savedPlaces} to="/saved" />
            <Stat label={t('Reviews written')} value={home.stats.reviewsWritten} />
          </div>

          <div className="home-grid">
            <section className="panel" aria-label={t('Next trip')}>
              <div className="between"><h2 style={{ margin: 0 }}>{t('Next trip')}</h2>{next && <Link to={`/trips/${next.tripId}`} className="small">{t('Open board')} <IconArrowRight size={14} aria-hidden="true" /></Link>}</div>
              {next ? (
                <div className="next-trip">
                  <Photo image={next.image ?? findDestination(catalog, next.destinationSlug)?.image} alt="" className="next-photo" credit={false} />
                  <div className="grow">
                    <div style={{ fontWeight: 500, fontSize: 16 }}>{cityOf(next.destination)} · {shortRange(next.startDate, next.endDate)}</div>
                    <div className="small muted"><IconUsers size={14} aria-hidden="true" /> {t(next.participantCount === 1 ? '{n} traveller' : '{n} travellers', { n: next.participantCount })}{next.onlineNow > 0 && ` · ${t('{n} online now', { n: next.onlineNow })}`} · {t(next.myRole)}</div>
                    <div className="small" style={{ marginTop: 8 }}>{t('Budget {used} of {total}', { used: price(next.groupCommitted, next.currency), total: price(next.totalBudget, next.currency) })}</div>
                    <div className={`bar ${next.groupCommitted > next.totalBudget ? 'over' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round((next.groupCommitted / next.totalBudget) * 100))} aria-label={t('Budget used')}>
                      <div style={{ width: `${Math.min(100, (next.groupCommitted / next.totalBudget) * 100)}%` }} />
                    </div>
                    <div className="small muted" style={{ marginTop: 6 }}>
                      {t(next.pinned === 1 ? '{n} place pinned' : '{n} places pinned', { n: next.pinned })} · {t(next.openVotes === 1 ? '{n} vote open' : '{n} votes open', { n: next.openVotes })}
                      {next.conflicts > 0 && <> · <span style={{ color: 'var(--warn-text)' }}><IconAlertCircle size={13} aria-hidden="true" /> {t(next.conflicts === 1 ? '{n} clash' : '{n} clashes', { n: next.conflicts })}</span></>}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="empty" style={{ marginTop: 10 }}>
                  <p className="muted small">{t('No upcoming trips yet.')}</p>
                  <Link to="/explore" className="btn primary">{t('Plan a trip')}</Link>
                </div>
              )}
            </section>

            <section className="panel" aria-label={t('Invitations and activity')}>
              <h2>{t('Invitations')}</h2>
              {home.invitations.length === 0 && <p className="small muted">{t('No invitations right now.')}</p>}
              {home.invitations.map((i) => (
                <div key={i.tripId} className="list-row">
                  <span><strong>{cityOf(i.destination)}</strong> <span className="muted">· {shortRange(i.startDate, i.endDate)}{i.invitedBy && ` · ${t('from {name}', { name: i.invitedBy })}`}</span></span>
                  <button className="small primary" onClick={() => navigate(`/join/${i.inviteCode}`)}>{t('Join')}</button>
                </div>
              ))}
              <h2 style={{ marginTop: 14 }}>{t('Recent activity')}</h2>
              {home.activity.length === 0 && <p className="small muted">{t('Nothing yet. Activity from your trips shows up here.')}</p>}
              <ul className="activity">
                {home.activity.map((a, n) => (
                  <li key={n}>
                    <Link to={`/trips/${a.tripId}`}>{t(ACTIVITY[a.type], { who: a.who === 'You' ? t('You') : a.who ?? t('Someone'), place: a.place ?? t('a place') })}</Link>
                    <span className="tiny muted"> · {a.trip} · {ago(a.at, t)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {trips?.length > 0 && (
            <section className="section">
              <div className="section-head"><h2>{t('Your trips')}</h2><Link to="/trips" className="small">{t('See all')}</Link></div>
              <div className="card-row">
                {trips.slice(0, 6).map((tr) => <TripCard key={tr.tripId} trip={tr} destination={findDestination(catalog, tr.destination)} />)}
              </div>
            </section>
          )}

          <nav className="quick-grid" aria-label={t('Quick links')}>
            <Link to="/explore"><IconCompass size={22} stroke={1.6} aria-hidden="true" /><span>{t('Explore places')}</span></Link>
            <Link to="/saved"><IconHeart size={22} stroke={1.6} aria-hidden="true" /><span>{t('Saved')}</span></Link>
            <Link to="/profile"><IconUser size={22} stroke={1.6} aria-hidden="true" /><span>{t('Your needs')}</span></Link>
            <Link to="/account"><IconShieldLock size={22} stroke={1.6} aria-hidden="true" /><span>{t('Account and security')}</span></Link>
          </nav>
          {!user.emailVerified && user.email && (
            <div className="banner warn" style={{ marginTop: 16 }}>
              <span className="grow">{t('Confirm your email to get trip invites and password resets.')}</span>
              <Link to="/account" className="small">{t('Confirm email')}</Link>
            </div>
          )}
        </>
      )}
      {joining && <JoinDialog onClose={() => setJoining(false)} />}
    </main>
  );
}

function Stat({ label, value, hint, to }) {
  const body = (
    <>
      <div className="tiny muted">{label}</div>
      <div className="stat-v">{value}</div>
      {hint && <div className="tiny faint">{hint}</div>}
    </>
  );
  return <div role="listitem">{to ? <Link to={to} className="stat">{body}</Link> : <div className="stat">{body}</div>}</div>;
}
