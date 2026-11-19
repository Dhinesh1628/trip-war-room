import { useEffect, useState } from 'react';
import { get } from './api.js';

// Every destination and its venues, loaded once per page load and shared by
// the explore page, saved places, the trip room and the pin dialog.
let cache = null;

async function load() {
  const { destinations } = await get('/destinations');
  const lists = await Promise.all(destinations.map((d) => get(`/destinations/${d.slug}/venues`)));
  const venues = [];
  const byId = new Map();
  destinations.forEach((d, i) => {
    for (const v of lists[i].venues) {
      const row = { ...v, destination: d.slug, destinationName: d.name, currency: d.currency };
      venues.push(row);
      byId.set(v.venueId, row);
    }
  });
  return { destinations, venues, byId };
}

export function loadCatalog() {
  if (!cache) cache = load().catch((err) => {
    cache = null;
    throw err;
  });
  return cache;
}

export function useCatalog() {
  const [state, setState] = useState({ catalog: null, error: null });
  useEffect(() => {
    let live = true;
    loadCatalog()
      .then((catalog) => live && setState({ catalog, error: null }))
      .catch((error) => live && setState({ catalog: null, error }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

// Destination by slug or display name ("jaipur" or "Jaipur, India").
export const findDestination = (catalog, key) =>
  catalog?.destinations.find((d) => d.slug === key || d.name === key) ?? null;

// The explore page's category buttons. Each maps to dataset categories.
export const EXPLORE_CATEGORIES = [
  { key: 'all', label: 'All', icon: 'IconCompass', categories: null },
  { key: 'landmarks', label: 'Landmarks', icon: 'IconBuildingCastle', categories: ['attraction'] },
  { key: 'tours', label: 'Tours and walks', icon: 'IconRoute', categories: ['tour'] },
  { key: 'experiences', label: 'Experiences', icon: 'IconTicket', categories: ['activity'] },
  { key: 'museums', label: 'Museums', icon: 'IconBuildingBank', categories: ['museum'] },
  { key: 'food', label: 'Food', icon: 'IconToolsKitchen2', categories: ['breakfast', 'lunch', 'dinner'] },
  { key: 'cafes', label: 'Cafes', icon: 'IconCoffee', categories: ['cafe'] },
  { key: 'nightlife', label: 'Nightlife', icon: 'IconGlassFull', categories: ['bar'] },
  { key: 'stays', label: 'Stays', icon: 'IconBed', categories: ['lodging'] },
];
