import path from "node:path";
import dotenv from "dotenv";

// Loaded before any other import — @zikbyte/queue and @zikbyte/storage read
// process.env at module load time, so this has to run first. Silently no-ops
// if repo-root .env doesn't exist (e.g. on Render, where real env vars are
// injected directly and this file is never deployed).
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

import crypto from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import express from "express";
import cors from "cors";
import multer from "multer";
import { nanoid } from "nanoid";
import {
  createCompressionQueue,
  createRedisClient,
  pointerKey,
  ACTIVE_JOBS_KEY,
  JOB_TTL_SECONDS,
} from "@zikbyte/queue";
import {
  createStorageClient,
  putObject,
  getDownloadUrl,
  uploadKey,
} from "@zikbyte/storage";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB

// The API only coordinates now — accept the upload, enqueue it, report status.
// Compression runs in @zikbyte/worker, never on this thread.
const queue = createCompressionQueue();
const redis = createRedisClient();
const storage = createStorageClient();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    // Cheap first filter only — the real "is it an image?" check is sharp, in the worker.
    const allowed = /^image\/(jpeg|png|webp|gif|tiff)$/i;
    cb(null, allowed.test(file.mimetype));
  },
});

// Phase 1 diagnostic: with real numbers, is the event loop itself ever the
// bottleneck under load, or is it the thread pool where sharp works?
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
setInterval(() => {
  const meanMs = eventLoopDelay.mean / 1e6;
  const p99Ms = eventLoopDelay.percentile(99) / 1e6;
  console.log(
    `[event-loop-lag] mean=${meanMs.toFixed(2)}ms p99=${p99Ms.toFixed(2)}ms`,
  );
  eventLoopDelay.reset();
}, 2000);

const app = express();
app.use(cors());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

app.post("/api/compress", upload.single("image"), async (req, res) => {
  if (!req.file) {
    res
      .status(400)
      .json({ error: "No image file provided, or file type not allowed." });
    return;
  }

  try {
    // Key everything by content hash: identical uploads dedupe to one job and one object.
    const contentHash = hashBuffer(req.file.buffer);
    const ext = path.extname(req.file.originalname) || "";
    const rawKey = uploadKey(contentHash, ext);
    await putObject(storage, rawKey, req.file.buffer, req.file.mimetype);

    await queue.add(
      "compress",
      { rawKey, outputId: contentHash, originalName: req.file.originalname },
      {
        jobId: contentHash,
        removeOnComplete: { age: JOB_TTL_SECONDS },
        removeOnFail: { age: JOB_TTL_SECONDS },
      },
    );

    // Client gets an unguessable public id; a short-lived Redis pointer maps it
    // to the hash, and the sorted set records when this job expires.
    const publicId = nanoid();
    const expiresAt = Date.now() + JOB_TTL_SECONDS * 1000;
    await redis
      .multi()
      .set(pointerKey(publicId), contentHash, "EX", JOB_TTL_SECONDS)
      .zadd(ACTIVE_JOBS_KEY, expiresAt, contentHash)
      .exec();

    res.status(202).json({ jobId: publicId });
  } catch (err) {
    console.error("[compress] upload failed:", err);
    res.status(500).json({ error: "Could not accept upload." });
  }
});

app.get("/api/jobs/:jobId", async (req, res) => {
  const contentHash = await redis.get(pointerKey(req.params.jobId));
  if (!contentHash) {
    res.status(404).json({ status: "not_found" });
    return;
  }

  const job = await queue.getJob(contentHash);
  if (!job) {
    res.status(410).json({ status: "expired" });
    return;
  }

  const state = await job.getState();
  if (state === "completed") {
    const { compressedKey, ...sizes } = job.returnvalue;
    const downloadUrl = await getDownloadUrl(
      storage,
      compressedKey,
      path.basename(compressedKey),
    );
    res.json({ status: "done", result: { ...sizes, downloadUrl } });
    return;
  }
  if (state === "failed") {
    res.json({
      status: "failed",
      error: job.failedReason ?? "Compression failed.",
    });
    return;
  }
  res.json({ status: "processing" });
});

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File too large." });
      return;
    }
    res.status(500).json({ error: "Unexpected server error." });
  },
);

app.listen(PORT, () => {
  console.log(`ZikByte API listening on http://localhost:${PORT}`);
});
