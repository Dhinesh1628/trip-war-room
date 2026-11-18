import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { buildServer } from '../src/server.js';

export const TEST_CONFIG = {
  port: 0,
  jwtSecret: 'test-secret-not-used-in-production',
  clientOrigin: 'http://localhost:5180',
  nodeEnv: 'test',
};

// Starts a throwaway in-memory MongoDB and a real HTTP + Socket.io server on a
// random free port. Returns everything a test needs plus a stop() function.
export async function startTestServer() {
  const mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());

  const { httpServer, app, gateway } = buildServer({ ...TEST_CONFIG, mongoUri: mongo.getUri() });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${httpServer.address().port}`;

  async function stop() {
    gateway.io.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await disconnectDb();
    await mongo.stop();
  }

  return { app, url, gateway, stop };
}
