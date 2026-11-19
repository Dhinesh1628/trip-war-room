import dns from 'node:dns';
import mongoose from 'mongoose';

// Atlas "mongodb+srv://" URIs need a DNS SRV lookup. On some Windows networks
// Node's resolver refuses it (querySrv ECONNREFUSED) even though nslookup works,
// so DNS_SERVERS lets you point Node at a public resolver, e.g. "8.8.8.8,1.1.1.1".
if (process.env.DNS_SERVERS) {
  dns.setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()));
}

// One shared, pooled connection for both Express and Socket.io (spec 9.2).
export async function connectDb(uri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  // Email became optional (phone and Google accounts), so the old
  // "email is unique" index is replaced by one that ignores missing emails.
  const { User } = await import('../auth/user.model.js');
  await User.syncIndexes();
  return mongoose.connection;
}

export function disconnectDb() {
  return mongoose.disconnect();
}

const STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

export function dbState() {
  return STATES[mongoose.connection.readyState] || 'unknown';
}
