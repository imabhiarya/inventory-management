import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDb } from '../src/db.js';
import User from '../src/models/User.js';

let replSet;

export async function startDb() {
  // Use a locally installed mongod if available (set MONGOMS_SYSTEM_BINARY), else download one.
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDb(replSet.getUri('mes_test'));
}

export async function stopDb() {
  await mongoose.disconnect();
  await replSet?.stop();
}

export async function resetDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

export async function makeUser(role = 'admin', username = `${role}user`, password = 'Passw0rd!') {
  await User.create({ username, name: `${role} user`, role, passwordHash: await User.hashPassword(password) });
  const agent = request.agent(createApp());
  const res = await agent.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.body.error}`);
  return agent;
}
