import { Server } from 'socket.io';
import { envelope } from './envelope.js';
import { RoomRegistry } from '../board/room.js';
import { attachTripNamespace, NAMESPACE } from './tripNamespace.js';

// Board Sync Gateway. Kept separate from the REST app so the two could be
// scaled independently later (spec 9.4).
//  - default namespace "/": only the latency ping/pong (used by the status page)
//  - "/trips": one connection per traveller per Trip Room (board, chat, presence)
export function createGateway(httpServer, config) {
  const io = new Server(httpServer, {
    cors: { origin: config.clientOrigin, credentials: true },
    maxHttpBufferSize: 64 * 1024, // no client event needs more than this
  });

  const startedAt = Date.now();
  const registry = new RoomRegistry({ flushIntervalMs: config.flushIntervalMs });

  io.on('connection', (socket) => {
    // trip.sync.ping { clientSentAt } -> trip.sync.pong { clientSentAt, serverReceivedAt }
    socket.on('trip.sync.ping', (msg = {}) => {
      const serverReceivedAt = Date.now();
      const clientSentAt = Number(msg?.payload?.clientSentAt) || null;
      socket.emit(
        'trip.sync.pong',
        envelope('trip.sync.pong', msg?.tripId, { clientSentAt, serverReceivedAt }),
      );
    });
  });

  const trips = attachTripNamespace(io, { config, registry });

  function health() {
    return {
      status: 'ok',
      connectedClients: io.engine.clientsCount,
      openRooms: registry.rooms.size,
      tripConnections: io.of(NAMESPACE).sockets.size,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
  }

  // Saves every open room, then closes all connections.
  async function shutdown() {
    trips.dispose();
    await registry.drainAll();
    io.close();
  }

  return { io, health, registry, shutdown };
}
