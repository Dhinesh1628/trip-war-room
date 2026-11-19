import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeServer, apiError, renderPage, axeViolations, catalogRoutes, USER } from './helpers.jsx';

// The API module is replaced by a fake server; each test sets its routes.
const state = vi.hoisted(() => ({ server: null, refreshUser: null }));
vi.mock('../lib/api.js', () => {
  const call = (m) => (path, body) => state.server.answer(m, path, body);
  return {
    get: call('GET'),
    post: (path, body = {}) => state.server.answer('POST', path, body),
    put: call('PUT'),
    patch: call('PATCH'),
    del: (path) => state.server.answer('DELETE', path),
    api: (method, path, body) => state.server.answer(method, path, body),
    refresh: () => (state.refreshUser ? Promise.resolve({ accessToken: 'tok', user: state.refreshUser }) : Promise.reject(Object.assign(new Error('no session'), { status: 401 }))),
    setToken: () => {},
    getToken: () => 'tok',
    onTokenChange: () => () => {},
  };
});

const { default: AuthPage } = await import('../pages/AuthPage.jsx');
const { default: ExplorePage } = await import('../pages/ExplorePage.jsx');
const { default: HomePage } = await import('../pages/HomePage.jsx');
const { default: AccountPage } = await import('../pages/AccountPage.jsx');
const { default: VenueDialog } = await import('../components/VenueDialog.jsx');
const { default: DateRangePicker } = await import('../components/DateRangePicker.jsx');
const { I18nProvider } = await import('../lib/i18n.jsx');

const PROVIDERS_EMAIL_ONLY = { google: null, phone: false, email: true, testInbox: false };
beforeEach(() => {
  state.refreshUser = null;
});
afterEach(() => vi.useRealTimers());

describe('date range calendar', () => {
  test('first click is the start, second the end; past days are off; too long a trip restarts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-05T12:00:00'));
    const onChange = vi.fn();
    const { rerender } = render(<I18nProvider><DateRangePicker start="" end="" onChange={onChange} onClose={() => {}} /></I18nProvider>);
    expect(screen.getByRole('button', { name: /(^|[^0-9])4 December 2026/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /(^|[^0-9])10 December 2026/ }));
    expect(onChange).toHaveBeenLastCalledWith({ start: '2026-12-10', end: '' });
    rerender(<I18nProvider><DateRangePicker start="2026-12-10" end="" onChange={onChange} onClose={() => {}} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /(^|[^0-9])13 December 2026/ }));
    expect(onChange).toHaveBeenLastCalledWith({ start: '2026-12-10', end: '2026-12-13' });
    // An earlier day restarts the range.
    fireEvent.click(screen.getByRole('button', { name: /(^|[^0-9])8 December 2026/ }));
    expect(onChange).toHaveBeenLastCalledWith({ start: '2026-12-08', end: '' });
    // More than 30 days restarts too.
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    fireEvent.click(screen.getByRole('button', { name: /(^|[^0-9])20 January 2027/ }));
    expect(onChange).toHaveBeenLastCalledWith({ start: '2027-01-20', end: '' });
  });
});

describe('sign in', () => {
  test('shows only the methods the server offers, and checks the form before sending', async () => {
    state.server = fakeServer({ 'GET /auth/providers': PROVIDERS_EMAIL_ONLY, 'POST /auth/login': apiError('Email or password is incorrect', { status: 401 }) });
    const user = userEvent.setup();
    renderPage(<AuthPage mode="signin" />, { route: '/signin' });
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Phone (OTP)' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    expect(state.server.calls.some((c) => c.path === '/auth/login')).toBe(false);

    await user.type(screen.getByLabelText('Email'), 'priya@example.test');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('checkbox', { name: 'Keep me signed in' }));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email or password is incorrect')).toBeInTheDocument();
    expect(state.server.calls.find((c) => c.path === '/auth/login').body).toEqual({ email: 'priya@example.test', password: 'wrong password', remember: false });
  });

  test('phone sign-in: number, code, then a name for a new account', async () => {
    state.server = fakeServer({
      'GET /auth/providers': { ...PROVIDERS_EMAIL_ONLY, phone: true },
      'POST /auth/otp/request': { phone: '+919876543210', expiresInSeconds: 300 },
      'POST /auth/otp/verify': (body) => (body.displayName ? { accessToken: 't', user: { ...USER, phone: '+919876543210', email: null } } : { needsName: true, phone: '+919876543210' }),
    });
    const user = userEvent.setup();
    renderPage(<AuthPage mode="signin" />, { route: '/signin' });
    await user.click(await screen.findByRole('tab', { name: 'Phone (OTP)' }));
    await user.type(screen.getByLabelText('Mobile number'), '98765 43210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(/We sent a 6-digit code to \+919876543210/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(screen.getByText('Enter the 6-digit code')).toBeInTheDocument();
    await user.type(screen.getByLabelText('6-digit code'), '12a3456');
    expect(screen.getByLabelText('6-digit code')).toHaveValue('123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText("You're new here. What should your group call you?")).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your name'), 'Ravi Kumar');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(state.server.calls.filter((c) => c.path === '/auth/otp/verify').at(-1).body).toMatchObject({ phone: '+919876543210', code: '123456', displayName: 'Ravi Kumar' }));
  });

  test('switching language translates the page', async () => {
    state.server = fakeServer({ 'GET /auth/providers': PROVIDERS_EMAIL_ONLY });
    const user = userEvent.setup();
    renderPage(<AuthPage mode="signin" />, { route: '/signin' });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Language' }), 'hi');
    expect(await screen.findByRole('heading', { name: 'फिर से स्वागत है' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('hi');
  });

  test('has no accessibility violations', async () => {
    state.server = fakeServer({ 'GET /auth/providers': { ...PROVIDERS_EMAIL_ONLY, phone: true } });
    const { container } = renderPage(<AuthPage mode="register" />, { route: '/register' });
    await screen.findByRole('heading', { name: 'Create your account' });
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('explore', () => {
  beforeEach(() => {
    state.refreshUser = USER;
    state.server = fakeServer({ ...catalogRoutes(), 'GET /auth/providers': PROVIDERS_EMAIL_ONLY, 'GET /users/me/saved': { saved: [] }, 'PUT /users/me/saved/*': { savedVenueIds: ['v_jai_012'] } });
  });

  test('search box, filters, sort and the heart', async () => {
    const user = userEvent.setup();
    renderPage(<ExplorePage />, { route: '/explore' });
    expect(await screen.findByText('5 places')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search places' }), 'thali');
    expect(screen.getByText('1 places')).toBeInTheDocument();
    expect(screen.getByText('Dal Baati House')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));

    await user.click(screen.getByRole('button', { name: 'vegetarian' }));
    expect(screen.getByText('3 places')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Price per person' }), '1000');
    expect(screen.getByText('2 places')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('5 places')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'priceHigh');
    const cards = screen.getAllByRole('article');
    expect(within(cards[0]).getByText('Panjim Heritage Inn')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save Hawa Mahal' }));
    expect(screen.getByRole('button', { name: 'Remove Hawa Mahal from saved' })).toHaveAttribute('aria-pressed', 'true');
    expect(state.server.calls.some((c) => c.method === 'PUT' && c.path === '/users/me/saved/v_jai_012')).toBe(true);
  });

  test('representative photos are labelled; an empty search says so', async () => {
    const user = userEvent.setup();
    renderPage(<ExplorePage />, { route: '/explore?city=jaipur' });
    expect(await screen.findByText('3 places')).toBeInTheDocument();
    expect(screen.getAllByText('Representative photo').length).toBe(2); // Hawa Mahal shows itself
    await user.type(screen.getByRole('searchbox', { name: 'Search places' }), 'zzzz');
    expect(screen.getByText('No places match')).toBeInTheDocument();
  });

  test('the trip search checks the form', async () => {
    const user = userEvent.setup();
    renderPage(<ExplorePage />, { route: '/explore' });
    await screen.findByText('5 places');
    await user.click(screen.getByRole('button', { name: 'Create trip room' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a city');
  });

  test('has no accessibility violations', async () => {
    const { container } = renderPage(<ExplorePage />, { route: '/explore' });
    await screen.findByText('5 places');
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('place details and reviews', () => {
  const venue = { ...catalogRoutes()['GET /destinations/jaipur/venues'].venues[1], destination: 'jaipur', destinationName: 'Jaipur, India', currency: 'INR' };
  beforeEach(() => {
    state.refreshUser = USER;
    let mine = null;
    state.server = fakeServer({
      'GET /auth/providers': PROVIDERS_EMAIL_ONLY,
      'GET /users/me/saved': { saved: [] },
      'GET /destinations/jaipur/venues/v_jai_004': { nearby: [{ venueId: 'v_jai_002', name: 'MI Road Lassi Bar', category: 'cafe', walkMinutes: 4, routed: true }] },
      'GET /destinations/jaipur/venues/v_jai_004/reviews': () => ({
        summary: mine ? { count: 2, average: 4.5 } : { count: 1, average: 4 },
        reviews: [{ reviewId: 'r1', userId: 'u2', displayName: 'Kabir', rating: 4, text: 'Good dal', updatedAt: '2026-11-01T00:00:00Z' }, ...(mine ? [mine] : [])],
        mine,
      }),
      'PUT /destinations/jaipur/venues/v_jai_004/reviews': (body) => {
        mine = { reviewId: 'r2', userId: 'u1', displayName: 'Priya Sharma', rating: body.rating, text: body.text, updatedAt: '2026-11-19T00:00:00Z' };
        return { review: mine };
      },
    });
  });

  test('shows nearby walking times, the photo note and reviews; posting needs stars', async () => {
    const user = userEvent.setup();
    renderPage(<VenueDialog venue={venue} onClose={() => {}} />);
    expect(await screen.findByText('MI Road Lassi Bar')).toBeInTheDocument();
    expect(screen.getByText('4 min walk')).toBeInTheDocument();
    expect(screen.getByText('The photo shows a related dish, street or landmark, not this exact place.')).toBeInTheDocument();
    expect(await screen.findByText('Good dal')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Post review' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose 1 to 5 stars');
    await user.click(screen.getByRole('radio', { name: '5 stars' }));
    await user.type(screen.getByRole('textbox', { name: 'Your review' }), 'Loved the thali');
    await user.click(screen.getByRole('button', { name: 'Post review' }));
    expect(await screen.findByText('Thanks, your review is posted.')).toBeInTheDocument();
    expect(await screen.findByText('Loved the thali')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit your review' })).toBeInTheDocument();
  });

  test('has no accessibility violations', async () => {
    const { container } = renderPage(<VenueDialog venue={venue} onClose={() => {}} />);
    await screen.findByText('Good dal');
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('home dashboard', () => {
  const HOME = {
    stats: { upcomingTrips: 2, plannedSpend: 18450, currency: 'INR', savedPlaces: 7, reviewsWritten: 3, openVotes: 1 },
    nextTrip: { tripId: 't1', destination: 'Jaipur, India', destinationSlug: 'jaipur', startDate: '2099-12-10', endDate: '2099-12-13', daysToGo: 21, myRole: 'leader', participantCount: 4, onlineNow: 3, pinned: 6, openVotes: 1, conflicts: 1, groupCommitted: 9200, totalBudget: 40000, currency: 'INR', image: null },
    invitations: [{ tripId: 't2', destination: 'Goa, India', startDate: '2099-01-02', endDate: '2099-01-06', inviteCode: 'AB-7Q2K', invitedBy: 'Sam' }],
    activity: [{ type: 'item_pinned', tripId: 't1', trip: 'Jaipur', who: 'Arjun', place: 'Amber Fort', at: new Date(Date.now() - 2 * 3600_000).toISOString() }],
  };
  beforeEach(() => {
    state.refreshUser = USER;
    state.server = fakeServer({
      ...catalogRoutes(),
      'GET /auth/providers': PROVIDERS_EMAIL_ONLY,
      'GET /users/me/saved': { saved: [] },
      'GET /users/me/home': HOME,
      'GET /users/me/dashboard': { trips: { led: [], joined: [] } },
    });
  });

  test('summary, next trip, invitations and activity', async () => {
    const user = userEvent.setup();
    renderPage(<HomePage />, { route: '/', path: '/' });
    expect(await screen.findByText('₹18,450')).toBeInTheDocument();
    expect(screen.getByText('Your Jaipur trip starts in 21 days')).toBeInTheDocument();
    expect(screen.getByText('Budget ₹9,200 of ₹40,000')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Budget used' })).toHaveAttribute('aria-valuenow', '23');
    expect(screen.getByText('Arjun pinned Amber Fort')).toBeInTheDocument();
    expect(screen.getByText(/2 h ago/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(screen.getByTestId('elsewhere')).toBeInTheDocument(); // went to /join/AB-7Q2K
  });

  test('has no accessibility violations', async () => {
    const { container } = renderPage(<HomePage />, { route: '/' });
    await screen.findByText('₹18,450');
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('account and security', () => {
  test('changing the password needs the current one; unconfirmed email can resend', async () => {
    state.refreshUser = { ...USER, emailVerified: false };
    state.server = fakeServer({
      'GET /auth/providers': PROVIDERS_EMAIL_ONLY,
      'GET /users/me/saved': { saved: [] },
      'POST /auth/password/change': (body) => (body.currentPassword === 'right one' ? { user: USER, signedOutSessions: 2 } : apiError('Your current password is incorrect')),
      'POST /auth/email/resend': { message: 'We sent a new link to priya@example.test.' },
    });
    const user = userEvent.setup();
    const { container } = renderPage(<AccountPage />, { route: '/account' });
    await user.click(await screen.findByRole('button', { name: 'Send link' }));
    expect(await screen.findByText('We sent a new link to priya@example.test.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your current password');
    await user.type(screen.getByLabelText('Current password'), 'wrong');
    await user.type(screen.getByLabelText('New password'), 'a new password');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your current password is incorrect');
    await user.clear(screen.getByLabelText('Current password'));
    await user.type(screen.getByLabelText('Current password'), 'right one');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText('Password saved. 2 other sessions were signed out.')).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});

// Keeps the act() warning noise down for state updates after a test ends.
afterEach(async () => {
  await act(async () => {});
});
