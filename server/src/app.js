import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { dbState } from './config/db.js';

// Builds the REST API. `gatewayHealth` is passed in so the API can report on
// the real-time gateway without importing it (keeps the layers separate).
export function createApp({ clientOrigin, gatewayHealth = () => null } = {}) {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: clientOrigin }));
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();

  // Health checks for an uptime monitor or container orchestrator (spec 10.3).
  api.get('/health', (req, res) => {
    const db = dbState();
    const ok = db === 'connected';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db });
  });

  api.get('/health/gateway', (req, res) => {
    const health = gatewayHealth();
    if (!health) return res.status(503).json({ status: 'unavailable' });
    res.json(health);
  });

  app.use('/api/v1', api);

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // Last-resort error handler: never leak stack traces to clients.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  return app;
}
