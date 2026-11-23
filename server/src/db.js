import mongoose from 'mongoose';
import logger from './logger.js';

mongoose.set('strictQuery', true);
// Note: every request input is parsed by a Zod schema into plain strings/numbers/dates
// before it reaches a query, so `$`-operator injection is not possible.

export async function connectDb(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  // Stock postings rely on multi-document transactions, which need a replica set.
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && !hello.msg) {
    throw new Error(
      'MongoDB is running as a standalone server. Transactions require a replica set: start mongod with --replSet rs0 and run rs.initiate() (see README).',
    );
  }
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  logger.info('MongoDB connected');
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
