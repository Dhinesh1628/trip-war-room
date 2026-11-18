import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { dbState } from './config/db.js';
import { HttpError } from './lib/errors.js';
import { authRouter } from './auth/auth.routes.js';
import { usersRouter } from './users/users.routes.js';
import { destinationsRouter } from './venues/venues.routes.js';
import { tripsRouter } from './trips/trips.routes.js';
import { adminRouter } from './admin/admin.routes.js';

// Builds the REST API. `gatewayHealth` is passed in so the API can report on
// the real-time gateway without importing it (keeps the layers separate).
export function createApp(config, { gatewayHealth = () => null, gateway = null } = {}) {
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

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

  api.use('/auth', authRouter(config));
  api.use('/users', usersRouter(config, { gateway }));
  api.use('/destinations', destinationsRouter(config));
  api.use('/trips', tripsRouter(config, { gateway }));
  api.use('/admin', adminRouter(config));

  app.use('/api/v1', api);

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // Last-resort error handler: known errors keep their status; anything else
  // is a 500 with no stack trace sent to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body is too large' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  return app;
}
