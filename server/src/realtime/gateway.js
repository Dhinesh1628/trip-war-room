import { Server } from 'socket.io';
import { envelope } from './envelope.js';
import { RoomRegistry } from '../board/room.js';
import { attachTripNamespace, NAMESPACE } from './tripNamespace.js';
import { roomActions } from './roomActions.js';
import { createLlmClient, providerLabel, warmUp } from '../concierge/answer.js';
import { askConcierge, rateLimitAsk } from '../concierge/concierge.js';
import { saveMessage, messageView } from '../chat/chatService.js';

// Board Sync Gateway. Kept separate from the REST app so the two could be
// scaled independently later (spec 9.4).
//  - default namespace "/": only the latency ping/pong (used by the status page)
//  - "/trips": one connection per traveller per Trip Room (board, chat, presence)
// The AI Concierge Engine is a separate module (src/concierge) that both the
// gateway and the REST API call.
export function createGateway(httpServer, config) {
  const io = new Server(httpServer, {
    cors: { origin: config.clientOrigin, credentials: true },
    maxHttpBufferSize: 64 * 1024, // no client event needs more than this
  });

  const startedAt = Date.now();
  const registry = new RoomRegistry({ flushIntervalMs: config.flushIntervalMs });
  // Tests inject a fake client as config.llm; otherwise one is made from the API key.
  const llm = config.llm !== undefined ? config.llm : createLlmClient(config);
  // A local model is loaded into memory now, not on the first question.
  if (config.llm === undefined) warmUp(llm);

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

  const nsp = io.of(NAMESPACE);
  const emit = (room, event, payload) => nsp.to(room.tripId).emit(event, envelope(event, room.tripId, payload));
  const actions = roomActions({ emit, config });
  registry.onOpen = actions.onRoomOpen;

  const askLog = new Map(); // userId -> recent question times

  // Answers a Concierge question and shares the answer with the whole room.
  async function ask(room, user, body) {
    rateLimitAsk(askLog, user.id, config.conciergeRateLimit);
    const { question, userId: _ignored, ...explicit } = body;
    const result = await askConcierge({ room, userId: user.id, question, explicit, llm, config });
    emit(room, 'trip.ai.suggestion', {
      questionId: result.questionId,
      userId: user.id,
      displayName: room.names.get(user.id) ?? user.name,
      question: result.question,
      answer: result.answer,
      suggestedVenueId: result.suggestedVenueId,
      sourceEvents: result.sourceEvents,
      mode: result.mode,
    });
    const { doc } = await saveMessage({
      tripId: room.tripId,
      type: 'ai_answer',
      body: result.answer,
      meta: {
        questionId: result.questionId,
        askedBy: user.id,
        question: result.question,
        suggestedVenueId: result.suggestedVenueId,
        sourceEvents: result.sourceEvents,
        mode: result.mode,
        latencyMs: result.latencyMs,
      },
    });
    emit(room, 'trip.chat.message', messageView(doc, room.names));
    return result;
  }

  const trips = attachTripNamespace(io, { config, registry, actions, ask, emit });

  function health() {
    return {
      status: 'ok',
      connectedClients: io.engine.clientsCount,
      openRooms: registry.rooms.size,
      tripConnections: io.of(NAMESPACE).sockets.size,
      concierge: providerLabel(llm),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
  }

  // Saves every open room, then closes all connections.
  async function shutdown() {
    trips.dispose();
    await registry.drainAll();
    io.close();
  }

  return { io, health, registry, actions, ask, shutdown };
}
