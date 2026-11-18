import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/env.js';
import { connectDb, disconnectDb } from './config/db.js';
import { createApp } from './app.js';
import { createGateway } from './realtime/gateway.js';

// Wires the REST app and the Socket.io gateway onto one HTTP server and port.
export function buildServer(config) {
  const httpServer = http.createServer();
  const gateway = createGateway(httpServer, config);
  const app = createApp({ clientOrigin: config.clientOrigin, gatewayHealth: gateway.health });
  httpServer.on('request', app);
  return { httpServer, app, gateway };
}

export async function main(env = process.env) {
  const config = loadConfig(env);
  const conn = await connectDb(config.mongoUri);
  console.log(`MongoDB connected: ${conn.host}/${conn.name}`);

  const { httpServer, gateway } = buildServer(config);
  httpServer.listen(config.port, () => {
    console.log(`API + gateway listening on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    gateway.io.close();
    httpServer.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only start when run directly (tests import buildServer instead).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
