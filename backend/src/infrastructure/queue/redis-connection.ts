import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * A connection for BullMQ. Background work may block for as long as a job
 * needs, so it sets no retry ceiling: BullMQ requires `maxRetriesPerRequest`
 * to be null on its own connection, and the ready check is skipped because the
 * worker itself waits for the connection.
 *
 * @param role Labels the connection in logs and lets one process hold more
 *   than one (the producer and the worker use separate clients).
 */
export function createRedisConnection(role: 'producer' | 'worker'): Redis {
  const connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectionName: `f-commerce-invites-${role}`,
    // Keep retrying in the background; a job run never depends on this socket
    // being ready at the instant the process starts.
    retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
    lazyConnect: false,
  });

  connection.on('error', (error) => {
    // Never log the URL: it may carry a password.
    console.error(`Redis ${role} connection error:`, error.message);
  });

  return connection;
}
