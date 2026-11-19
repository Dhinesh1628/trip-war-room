import express from 'express';
import { getOutbox, clearOutbox } from './notify.js';

// Test inbox for local development: the emails and text messages the server
// would have sent. Mounted only outside production (config.devOutbox).
export function devRouter() {
  const router = express.Router();
  router.get('/outbox', (req, res) => res.json({ messages: getOutbox() }));
  router.delete('/outbox', (req, res) => {
    clearOutbox();
    res.status(204).end();
  });
  return router;
}
