// Runs the server against a throwaway in-memory MongoDB, so you can try the
// app without installing MongoDB or creating an Atlas cluster.
// All data is lost when the process stops.
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { main } from '../src/server.js';

const mongo = await MongoMemoryServer.create();
console.log('Using in-memory MongoDB (data is discarded on exit)');

await main({
  ...process.env,
  MONGO_URI: mongo.getUri('trip-war-room'),
  JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex'),
});
