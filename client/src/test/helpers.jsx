import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axe from 'axe-core';
import { I18nProvider } from '../lib/i18n.jsx';
import { AuthProvider } from '../lib/auth.jsx';
import { SavedProvider } from '../lib/saved.jsx';

// A fake server for screen tests: routes like 'GET /users/me/home' map to a
// value or a function (body, path) => value. Unknown routes fail loudly.
export function fakeServer(routes) {
  const calls = [];
  const answer = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    const match = Object.keys(routes).find((k) => k === key || (k.endsWith('*') && key.startsWith(k.slice(0, -1))));
    if (!match) throw Object.assign(new Error(`No fake for ${key}`), { status: 404 });
    const r = routes[match];
    const v = typeof r === 'function' ? await r(body, path) : r;
    if (v instanceof Error) throw v;
    return structuredClone(v);
  };
  return { calls, answer };
}

export const apiError = (message, { status = 400, code = 'VALIDATION_FAILED', details } = {}) => Object.assign(new Error(message), { status, code, details });

export const USER = { id: 'u1', email: 'priya@example.test', emailVerified: true, phone: null, googleLinked: false, passwordSet: true, displayName: 'Priya Sharma', role: 'user', preferences: { dietaryTags: [], budgetCeiling: null } };

// Renders a page inside the app's providers and a router.
export function renderPage(ui, { route = '/', path = '*', lang = 'en' } = {}) {
  return render(
    <I18nProvider lang={lang}>
      <AuthProvider>
        <SavedProvider>
          <MemoryRouter initialEntries={[route]}>
            <Routes>
              <Route path={path} element={ui} />
              <Route path="*" element={<div data-testid="elsewhere" />} />
            </Routes>
          </MemoryRouter>
        </SavedProvider>
      </AuthProvider>
    </I18nProvider>,
  );
}

// Accessibility check with axe-core. Colour contrast needs real layout, which
// jsdom doesn't have, so that rule is checked in the browser instead.
export async function axeViolations(container) {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

// A small catalog: two cities, a few places.
export const DESTINATIONS = [
  { slug: 'goa', name: 'Goa, India', country: 'India', currency: 'INR', image: { url: '/photos/goa.jpg', credit: 'A', license: 'CC BY-SA 4.0', source: 'https://commons.wikimedia.org/wiki/File:Goa.jpg' }, venueCount: 2 },
  { slug: 'jaipur', name: 'Jaipur, India', country: 'India', currency: 'INR', image: { url: '/photos/jaipur.jpg', credit: 'B', license: 'CC BY-SA 4.0', source: 'https://commons.wikimedia.org/wiki/File:Jaipur.jpg' }, venueCount: 3 },
];
const venue = (o) => ({
  category: 'dinner', neighborhood: 'Pink City', dietaryTags: [], hours: { open: '10:00', close: '22:00' }, coordinates: { lat: 26.92, lng: 75.82 },
  rating: 4.4, reviewCount: 100, indoor: true, description: 'A place to eat.', image: { url: '/photos/x.jpg', credit: 'C', license: 'CC BY 2.0', source: 'https://commons.wikimedia.org/wiki/File:X.jpg', representative: true },
  travellerReviews: { count: 0, average: null }, ...o,
});
export const VENUES = {
  jaipur: [
    venue({ venueId: 'v_jai_012', name: 'Hawa Mahal', category: 'attraction', pricePerPerson: 50, rating: 4.5, reviewCount: 72000, hours: { open: '09:00', close: '16:30' }, image: { url: '/photos/hawa.jpg', credit: 'D', license: 'CC BY-SA 4.0', source: 'https://commons.wikimedia.org/wiki/File:Hawa.jpg', representative: false } }),
    venue({ venueId: 'v_jai_004', name: 'Dal Baati House', category: 'lunch', pricePerPerson: 400, dietaryTags: ['vegetarian'], description: 'Rajasthani thali and dal baati.', travellerReviews: { count: 2, average: 4.5 } }),
    venue({ venueId: 'v_jai_008', name: 'Palace Courtyard Restaurant', pricePerPerson: 2500, rating: 4.7, dietaryTags: ['vegetarian', 'gluten-free'], hours: { open: '19:00', close: '23:00' } }),
  ],
  goa: [
    venue({ venueId: 'v_goa_014', name: 'Baga Beach Shack', neighborhood: 'Baga', pricePerPerson: 900, rating: 4.2, dietaryTags: ['vegetarian'], hours: { open: '10:00', close: '23:30' } }),
    venue({ venueId: 'v_goa_020', name: 'Panjim Heritage Inn', category: 'lodging', neighborhood: 'Panaji', pricePerPerson: 3000, rating: 4.5, hours: { open: '00:00', close: '23:59' } }),
  ],
};

export function catalogRoutes() {
  return {
    'GET /destinations': { destinations: DESTINATIONS },
    'GET /destinations/goa/venues': { venues: VENUES.goa },
    'GET /destinations/jaipur/venues': { venues: VENUES.jaipur },
  };
}
