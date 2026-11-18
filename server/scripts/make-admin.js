// Gives an existing account the Admin role (or removes it with --revoke).
// Register the account in the app first, then run:
//   npm run make-admin -- someone@example.com
//   npm run make-admin -- someone@example.com --revoke
import { loadConfig } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { User } from '../src/auth/user.model.js';

const email = process.argv[2]?.trim().toLowerCase();
const revoke = process.argv.includes('--revoke');
if (!email || email.startsWith('--')) {
  console.error('Usage: npm run make-admin -- <email> [--revoke]');
  process.exit(1);
}

const config = loadConfig();
await connectDb(config.mongoUri);
try {
  const user = await User.findOneAndUpdate(
    { email },
    { role: revoke ? 'user' : 'admin' },
    { returnDocument: 'after' },
  );
  if (!user) {
    console.error(`No account found for ${email}. Register it first.`);
    process.exitCode = 1;
  } else {
    console.log(`${user.email} is now role "${user.role}".`);
  }
} finally {
  await disconnectDb();
}
