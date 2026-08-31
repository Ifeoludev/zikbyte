import path from "node:path";
import dotenv from "dotenv";

// Loaded before any other import — @zikbyte/storage reads process.env at
// module load time, so this has to run first. Silently no-ops if repo-root
// .env doesn't exist (e.g. on Render, where real env vars are injected
// directly and this file is never deployed).
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import multer from "multer";
import { compressImage, extensionFor, contentTypeFor } from "@zikbyte/core";
import {
  createStorageClient,
  putObject,
  getDownloadUrl,
  compressedKey,
} from "@zikbyte/storage";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB

const storage = createStorageClient();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    // Cheap first filter only — the real "is it an image?" check is sharp, below.
    const allowed = /^image\/(jpeg|png|webp|gif|tiff)$/i;
    cb(null, allowed.test(file.mimetype));
  },
});

const app = express();
// Unset locally (Vite's dev proxy makes web and api same-origin, so CORS
// never enters into it there) — Render's static site and api live on
// different domains in production, so CORS_ORIGIN gets set to the deployed
// frontend's exact URL there.
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(corsOrigin ? { origin: corsOrigin } : undefined));

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

  let result;
  try {
    result = await compressImage({ input: req.file.buffer });
  } catch (err) {
    console.error("[compress] sharp rejected the upload:", err);
    res.status(400).json({ error: "Not a valid image." });
    return;
  }

  try {
    // Content hash as the object key: re-uploading the same bytes just
    // overwrites the same key, so this is free idempotency without needing
    // anything to track "have we seen this before."
    const hash = hashBuffer(req.file.buffer);
    const key = compressedKey(hash, extensionFor(result.format));
    await putObject(storage, key, result.output, contentTypeFor(result.format));
    const downloadUrl = await getDownloadUrl(storage, key, path.basename(key));

    res.json({
      downloadUrl,
      originalSizeBytes: result.originalSizeBytes,
      compressedSizeBytes: result.compressedSizeBytes,
      savedPercent: result.savedPercent,
    });
  } catch (err) {
    console.error("[compress] storage upload failed:", err);
    res.status(500).json({ error: "Could not store compressed image." });
  }
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
