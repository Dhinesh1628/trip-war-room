import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Without a connection the trip room shows the copy of the board saved on
// this device, read-only; sign-out clears those copies.
const room = vi.hoisted(() => ({ value: null }));
vi.mock('../lib/useTripRoom.js', () => ({ useTripRoom: () => room.value }));
vi.mock('../lib/api.js', () => ({ get: () => Promise.reject(new Error('offline')), post: () => Promise.reject(new Error('offline')) }));

const { default: TripRoom } = await import('../pages/TripRoom.jsx');
const { saveBoard, loadBoard, clearBoards } = await import('../lib/offline.js');
const { I18nProvider } = await import('../lib/i18n.jsx');

const LIVE = {
  status: 'live',
  trip: { destination: 'Goa, India', destinationSlug: 'goa', startDate: '2026-12-20', endDate: '2026-12-21', dayCount: 2, totalBudget: 40000 },
  items: { i1: { itemId: 'i1', venueId: 'v_goa_012', venue: { name: 'Fontainhas Latin Quarter Walk', pricePerPerson: 700, neighborhood: 'Fontainhas' }, dayIndex: 0, startTime: '08:00', endTime: '10:30', lifecycleStage: 'drafting', positionVersion: 1 } },
  participants: [{ userId: 'u1', displayName: 'Ananya Rao', role: 'leader', online: true }],
  budget: { totalBudget: 40000, groupCommitted: 700 },
  me: { userId: 'u1', role: 'leader' },
};
const renderRoom = () =>
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/trips/t1']}>
        <Routes><Route path="/trips/:tripId" element={<TripRoom />} /></Routes>
      </MemoryRouter>
    </I18nProvider>,
  );

describe('offline trip room', () => {
  test('shows the last saved board, read-only, when the server is unreachable', () => {
    saveBoard('t1', LIVE);
    expect(loadBoard('t1').participants[0].online).toBe(false); // presence isn't kept
    room.value = { status: 'error', error: 'Network error', trip: null, items: {}, participants: [], conflicts: [], votes: {}, chat: [] };
    renderRoom();
    expect(screen.getByText(/Offline: showing your last saved board/)).toBeInTheDocument();
    expect(screen.getByText('Fontainhas Latin Quarter Walk')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pin a venue' })).not.toBeInTheDocument();
    expect(screen.getByText('Offline: this is your last saved board. Changes need a connection.')).toBeInTheDocument();
  });

  test('says so when nothing was saved on this device', () => {
    room.value = { status: 'error', error: 'Network error', trip: null, items: {}, participants: [], conflicts: [], votes: {}, chat: [] };
    renderRoom();
    expect(screen.getByText('Network error')).toBeInTheDocument();
  });

  test('signing out clears saved boards', () => {
    saveBoard('t1', LIVE);
    saveBoard('t2', LIVE);
    clearBoards();
    expect(loadBoard('t1')).toBeNull();
    expect(loadBoard('t2')).toBeNull();
  });
});
