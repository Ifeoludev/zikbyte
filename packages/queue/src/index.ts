import { Queue, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";

// Shared vocabulary for Phase 2: the API imports this to enqueue work,
// the worker imports it to consume. Nothing else talks to BullMQ or Redis.

export const COMPRESSION_QUEUE_NAME = "compression";
export const ACTIVE_JOBS_KEY = "active-jobs";
export const JOB_TTL_SECONDS = 60 * 60; // 1 hour

// Functions, not module-level constants: tsx/Node run this file's imports
// with ESM hoisting semantics, so a top-level `const REDIS_URL = process.env...`
// would capture its value before the entrypoint's dotenv.config() call ever
// runs, regardless of where that call sits in server.ts/worker.ts. Reading
// lazily, at call time, sidesteps that entirely.
//
// Port 6380, not the usual 6379, so ZikByte's Redis never collides with
// another project's Redis on this machine. See compose.yaml.
function redisUrl(): string {
  return process.env.REDIS_URL ?? "redis://localhost:6380";
}

export function getRedisConnectionOptions(): ConnectionOptions {
  const url = new URL(redisUrl());
  const options: ConnectionOptions = {
    host: url.hostname || "localhost",
    port: url.port ? Number(url.port) : 6380,
  };
  // Local Redis (redis://, no auth) has none of these; a hosted provider like
  // Upstash (rediss://, username+password) needs all three, and this rebuild
  // was silently dropping them before — BullMQ's Queue/Worker connection
  // option takes a plain object, not the URL string createRedisClient() below
  // gets to pass straight through to ioredis.
  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  if (url.protocol === "rediss:") options.tls = {};
  return options;
}

export interface CompressionJobData {
  rawKey: string; // storage key of the uploaded original
  outputId: string; // content hash — used to build the compressed object's key
  originalName: string;
}

export interface CompressionJobResult {
  compressedKey: string; // storage key of the compressed output
  originalSizeBytes: number;
  compressedSizeBytes: number;
  savedPercent: number;
}

export function createCompressionQueue() {
  return new Queue<CompressionJobData, CompressionJobResult>(
    COMPRESSION_QUEUE_NAME,
    { connection: getRedisConnectionOptions() },
  );
}

// Our own Redis client for the two things BullMQ doesn't model:
// the public-id -> content-hash pointer, and the expiry sorted set.
export function createRedisClient(): IORedis {
  return new IORedis(redisUrl(), { maxRetriesPerRequest: null });
}

export function pointerKey(publicId: string): string {
  return `job:${publicId}`;
}
