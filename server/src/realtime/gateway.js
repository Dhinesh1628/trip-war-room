import { Server } from 'socket.io';
import { envelope } from './envelope.js';

// Board Sync Gateway. Kept separate from the REST app so the two could be
// scaled independently later (spec 9.4). Phase 0 only has the latency
// ping/pong; board, chat, presence and votes arrive in Phase 2.
export function createGateway(httpServer, { clientOrigin }) {
  const io = new Server(httpServer, {
    cors: { origin: clientOrigin },
  });

  const startedAt = Date.now();

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

  function health() {
    return {
      status: 'ok',
      connectedClients: io.engine.clientsCount,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
  }

  return { io, health };
}
