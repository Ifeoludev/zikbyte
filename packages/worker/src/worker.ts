import path from "node:path";
import dotenv from "dotenv";

// Loaded before any other import — @zikbyte/queue and @zikbyte/storage read
// process.env at module load time, so this has to run first. Silently no-ops
// if repo-root .env doesn't exist (e.g. on Render, where real env vars are
// injected directly and this file is never deployed).
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

import { Worker } from "bullmq";
import { compressImage, extensionFor, contentTypeFor } from "@zikbyte/core";
import {
  COMPRESSION_QUEUE_NAME,
  ACTIVE_JOBS_KEY,
  getRedisConnectionOptions,
  createRedisClient,
  createCompressionQueue,
  type CompressionJobData,
  type CompressionJobResult,
} from "@zikbyte/queue";
import {
  createStorageClient,
  getObject,
  putObject,
  deleteObject,
  deleteObjectsByPrefix,
  compressedKey,
  UPLOADS_PREFIX,
  COMPRESSED_PREFIX,
} from "@zikbyte/storage";

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

const storage = createStorageClient();

const worker = new Worker<CompressionJobData, CompressionJobResult>(
  COMPRESSION_QUEUE_NAME,
  async (job) => {
    const { rawKey, outputId } = job.data;
    const input = await getObject(storage, rawKey);
    const result = await compressImage({ input });

    const key = compressedKey(outputId, extensionFor(result.format));
    await putObject(storage, key, result.output, contentTypeFor(result.format));

    return {
      compressedKey: key,
      originalSizeBytes: result.originalSizeBytes,
      compressedSizeBytes: result.compressedSizeBytes,
      savedPercent: result.savedPercent,
    };
  },
  { connection: getRedisConnectionOptions(), concurrency: CONCURRENCY },
);

worker.on("completed", (job) => {
  console.log(
    `[worker] ${job.id} done — saved ${job.returnvalue.savedPercent}%`,
  );
  deleteObject(storage, job.data.rawKey).catch(() => {});
});

// A job fails here when sharp rejects the bytes — this is the real "is it
// actually an image?" check, surfaced to the client as a failed job status.
worker.on("failed", (job, err) => {
  console.error(`[worker] ${job?.id ?? "?"} failed: ${err.message}`);
  if (job) deleteObject(storage, job.data.rawKey).catch(() => {});
});

console.log(
  `[worker] listening on "${COMPRESSION_QUEUE_NAME}" — concurrency=${CONCURRENCY}`,
);

// Expiry sweep: delete objects and job records once their hour is up.
// Prefix-based deletion, not job.returnvalue lookups, so cleanup still works
// even if BullMQ's own removeOnComplete age-TTL already reaped the job record.
const redis = createRedisClient();
const queue = createCompressionQueue();

async function sweep(): Promise<void> {
  const now = Date.now();
  const expired = await redis.zrangebyscore(ACTIVE_JOBS_KEY, 0, now);
  if (expired.length === 0) return;

  for (const hash of expired) {
    await deleteObjectsByPrefix(storage, `${UPLOADS_PREFIX}${hash}`);
    await deleteObjectsByPrefix(storage, `${COMPRESSED_PREFIX}${hash}`);
    const job = await queue.getJob(hash);
    if (job) await job.remove().catch(() => {});
    await redis.zrem(ACTIVE_JOBS_KEY, hash);
  }
  console.log(`[sweep] reclaimed ${expired.length} expired job(s)`);
}

const sweepTimer = setInterval(() => {
  sweep().catch((err) => console.error("[sweep] error", err));
}, SWEEP_INTERVAL_MS);

async function shutdown(): Promise<void> {
  clearInterval(sweepTimer);
  await worker.close();
  await queue.close();
  redis.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
