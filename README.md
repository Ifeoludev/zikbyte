# ZikByte

An image compression service. Upload a JPEG, PNG, WebP, GIF, or TIFF and get a resized, re-encoded version back in a single request — original size, compressed size, percent saved, and a direct download link.

Live: https://zikbyte-web.onrender.com

---

## What it does

- Compresses an uploaded image in one request: resize to a max dimension, re-encode at a fixed quality, return a download link
- Chooses the output format (JPEG via mozjpeg, PNG, or WebP) from the input format
- Never upscales — images smaller than the max dimension pass through resize untouched
- Stores compressed output in Backblaze B2 and hands back a time-limited pre-signed download URL
- Re-uploading identical bytes reuses the same stored object instead of recompressing

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Tailwind CSS v4, Vite |
| Backend | Express 4, TypeScript, Node.js |
| Image processing | sharp (mozjpeg-backed JPEG encoding) |
| Storage | Backblaze B2 (S3-compatible), via `@aws-sdk/client-s3` |
| Deployed | Render (API as a web service, frontend as a static site) |

---

## Architecture decisions

**Synchronous request/response over a queue**

ZikByte originally had a BullMQ/Redis queue and a separate worker process: uploads got an instant job ID and the client polled for status. Real traffic is close to one upload a day, and Render's free-tier worker only wakes on direct HTTP to its own URL, not on a job landing in Redis — so an enqueued job could sit unprocessed indefinitely with nothing to nudge it. Rather than patch around that gap, the app collapsed back to upload → compress → download in one request. BullMQ, ioredis, Upstash, and the worker's health-check-only Render service were all removed.

**Buffer-in, Buffer-out compression seam**

`compressImage` in `packages/core` takes and returns Buffers, not file paths — it never touches the filesystem. That's what let storage move from local disk to B2 to a queued worker and back to a single process without changing the compression logic itself.

**Backblaze B2 over Cloudflare R2**

Both are S3-compatible with the same code path, so this came down to signup friction: R2 requires a credit card on file to activate its free tier, even though the tier itself never charges. B2's free tier (10GB storage, free egress up to 3x stored data) needs no card.

**Content-hash object keys for idempotency**

The compressed object's key in B2 is the SHA-256 hash of the uploaded bytes. Re-uploading the same file overwrites the same key instead of recompressing and storing a duplicate — idempotency without a database or cache to track what's already been seen.

**No database**

There are no accounts and nothing to query across requests — each upload is compressed, stored, and handed back a download link in one exchange. A database would exist only to satisfy the idea of having one, not an actual need.

**Bucket lifecycle rule over an app-level expiry sweep**

Compressed objects age out via a B2 lifecycle rule rather than a scheduled job in the app tracking and deleting old files. B2 already does this natively, so nothing in the app needs to.

---

## Engineering notes

**A load test found the real bottleneck before anything was built to fix it**

Before adding a queue at all, autocannon load tests against the synchronous endpoint showed throughput pinned around 8 req/sec regardless of concurrency, with latency climbing linearly — the signature of a fixed-capacity resource queuing work behind it. Logging event-loop lag alongside it confirmed the event loop itself stayed responsive; the actual ceiling was libuv's default 4-thread pool, where sharp's compression and multer's upload handling both ran. That measurement, not a guess, was the basis for introducing a worker process — and later for recognizing it wasn't warranted at this traffic level either.

**Env vars are read lazily, not at module load**

`packages/storage` reads B2 credentials inside functions (`bucketName()`, etc.) rather than top-level constants. Under ESM-hoisting semantics, `import` statements resolve before an entrypoint's own `dotenv.config()` call runs, regardless of where that call sits in source order — a top-level `const` would capture `undefined` before the `.env` file loads. Reading env vars at call time instead sidesteps the ordering problem entirely.

**The upload's content hash is the only link between the API route and storage**

`/api/compress` hashes the compressed output and uses that hash as the B2 object key, so there's no job ID, database row, or in-memory map needed to connect a request to a stored file.

---

## What I learned

**Measure before building the fix**

The instinct on hitting a naive endpoint's ceiling was "Node is single-threaded, add a queue." Load-testing first showed ~8 req/sec, not the ~2 req/sec true full serialization would produce — several requests really were running in parallel, just capped by the thread pool, not the event loop. Building a queue on the wrong mental model would have solved the wrong problem.

**Infrastructure has to earn its place at actual traffic**

The queue/worker rebuild made sense at meaningfully concurrent load, but real usage never got there. Free-tier hosting's specific failure mode — a worker that wakes only on HTTP traffic, not on a Redis job appearing — made that gap concrete instead of theoretical. Collapsing back to one request-response cycle removed four moving pieces (BullMQ, ioredis, Upstash, a second Render service) for no loss at the traffic this actually sees.

**A stale comment is worse than no comment**

Comments explaining a decision — env var timing, a since-removed background worker — outlive the code they described once that code is deleted, and end up contradicting what's around them. Worth checking comments for continued accuracy whenever the architecture they reference changes, not just when the code they're attached to changes.

---

## Local development

**Prerequisites** — Node.js 24+, a Backblaze B2 bucket and application key

```bash
git clone https://github.com/Ifeoludev/zikbyte.git
cd zikbyte
npm install
```

Create `.env` at the repo root:

```env
PORT=4000
B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
B2_REGION=us-west-004
B2_BUCKET=
B2_KEY_ID=
B2_APPLICATION_KEY=
```

Run the API and web app together:

```bash
npm run dev
```

The Vite dev server proxies `/api` to `localhost:4000` automatically, so no `VITE_API_URL` is needed in development.

---

## Environment variables

### Server

| Variable | Description |
|---|---|
| `PORT` | API HTTP port (defaults to 4000) |
| `B2_ENDPOINT` | B2 S3-compatible endpoint URL |
| `B2_REGION` | B2 region (e.g. `us-west-004`) |
| `B2_BUCKET` | B2 bucket name |
| `B2_KEY_ID` | B2 application key ID |
| `B2_APPLICATION_KEY` | B2 application key |
| `CORS_ORIGIN` | Allowed frontend origin in production (unset in dev — Vite's proxy makes it same-origin) |

### Client

| Variable | Description |
|---|---|
| `VITE_API_URL` | Backend origin in production (e.g. `https://zikbyte-api.onrender.com`) |

---

## Project structure

```
zikbyte/
├── packages/
│   ├── core/
│   │   └── src/index.ts          # compressImage — the one seam, Buffer in/out
│   ├── storage/
│   │   └── src/index.ts          # B2 client, putObject, pre-signed download URLs
│   ├── api/
│   │   ├── src/server.ts         # Express app: /api/compress, /api/health
│   │   └── scripts/              # autocannon load-test scripts
│   └── web/
│       └── src/
│           ├── App.tsx           # upload form + result panel
│           └── main.tsx
└── render.yaml                   # Render Blueprint: api web service + web static site
```
