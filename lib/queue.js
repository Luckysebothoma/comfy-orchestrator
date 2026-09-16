import Redis from "ioredis";

const QUEUE_KEY = process.env.REDIS_QUEUE_KEY || "comfy:jobs:queue";

export const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT || 6379),
  db: Number(process.env.REDIS_DB || 0),
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

export async function enqueue(jobId) {
  await redis.lpush(QUEUE_KEY, jobId);
}

// Blocking pop with timeout (seconds). Returns null on timeout.
export async function dequeueBlocking(timeoutSec = 5) {
  const res = await redis.brpop(QUEUE_KEY, timeoutSec);
  return res ? res[1] : null;
}

export { QUEUE_KEY };
