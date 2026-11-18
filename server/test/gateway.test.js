import { io as connect } from 'socket.io-client';
import { startTestServer } from './helpers.js';

let server;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.stop();
});

function openClient() {
  return new Promise((resolve, reject) => {
    const socket = connect(server.url, { transports: ['websocket'], forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

describe('board sync gateway (Phase 0 smoke test)', () => {
  test('answers trip.sync.ping with a pong in the shared envelope shape', async () => {
    const socket = await openClient();
    const clientSentAt = Date.now();

    const pong = await new Promise((resolve) => {
      socket.once('trip.sync.pong', resolve);
      socket.emit('trip.sync.ping', { event: 'trip.sync.ping', tripId: 'tr_1', payload: { clientSentAt }, ts: clientSentAt });
    });

    expect(pong).toMatchObject({ event: 'trip.sync.pong', tripId: 'tr_1' });
    expect(pong.payload.clientSentAt).toBe(clientSentAt);
    expect(pong.payload.serverReceivedAt).toBeGreaterThanOrEqual(clientSentAt);
    expect(typeof pong.ts).toBe('number');
    socket.close();
  });

  test('gateway health counts live connections', async () => {
    const a = await openClient();
    const b = await openClient();
    expect(server.gateway.health().connectedClients).toBe(2);
    a.close();
    b.close();
  });
});
