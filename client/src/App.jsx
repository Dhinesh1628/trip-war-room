import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

// Phase 0 placeholder: proves the client can reach the REST API and the
// WebSocket gateway. The real trip board is built in Phase 5, after the
// mockup is approved.
export default function App() {
  const [api, setApi] = useState('checking');
  const [gateway, setGateway] = useState('connecting');
  const [latency, setLatency] = useState(null);

  useEffect(() => {
    fetch('/api/v1/health')
      .then((r) => r.json())
      .then((body) => setApi(body.status === 'ok' ? `ok (database ${body.db})` : `degraded (database ${body.db})`))
      .catch(() => setApi('unreachable'));

    const socket = io({ transports: ['websocket'] });
    socket.on('connect', () => {
      setGateway('connected');
      socket.emit('trip.sync.ping', { event: 'trip.sync.ping', tripId: null, payload: { clientSentAt: Date.now() }, ts: Date.now() });
    });
    socket.on('connect_error', () => setGateway('unreachable'));
    socket.on('disconnect', () => setGateway('disconnected'));
    socket.on('trip.sync.pong', (msg) => setLatency(Date.now() - msg.payload.clientSentAt));

    return () => socket.close();
  }, []);

  return (
    <main className="status">
      <h1>Trip War Room</h1>
      <p className="muted">Development build. Phase 0: project setup.</p>
      <dl>
        <dt>REST API</dt>
        <dd data-testid="api-status">{api}</dd>
        <dt>Real-time gateway</dt>
        <dd data-testid="gateway-status">{gateway}</dd>
        <dt>Round trip</dt>
        <dd data-testid="latency">{latency === null ? '—' : `${latency} ms`}</dd>
      </dl>
    </main>
  );
}
