import sharp from "sharp";
import { createCompressionQueue } from "@zikbyte/queue";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const COUNT = Number(arg("--count", "24"));
const URL = arg("--url", "http://localhost:4000/api/compress");

// Gradient JPEGs — realistic compression cost per job. Each image gets a
// slightly different width so its bytes (and content hash) are unique and
// jobs don't dedupe.
async function makeImages(n: number): Promise<Buffer[]> {
  const h = 1800;
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const w = 2600 + i;
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 3;
        raw[o] = (x * 255) / w;
        raw[o + 1] = (y * 255) / h;
        raw[o + 2] = ((x + y) * 255) / (w + h);
      }
    }
    out.push(
      await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
        .jpeg({ quality: 90 })
        .toBuffer(),
    );
  }
  return out;
}

const queue = createCompressionQueue();

async function pending(): Promise<number> {
  const c = await queue.getJobCounts("waiting", "active", "delayed", "prioritized");
  return (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0) + (c.prioritized ?? 0);
}

async function main() {
  console.log(`Generating ${COUNT} unique test images…`);
  const images = await makeImages(COUNT);

  // Start from an empty queue so the timing only covers this run's jobs.
  await queue.obliterate({ force: true });

  const t0 = Date.now();
  await Promise.all(
    images.map(async (buf, i) => {
      const fd = new FormData();
      fd.append("image", new Blob([buf], { type: "image/jpeg" }), `w-${i}.jpg`);
      const res = await fetch(URL, { method: "POST", body: fd });
      if (res.status !== 202) throw new Error(`upload ${i}: HTTP ${res.status}`);
    }),
  );
  const uploadedMs = Date.now() - t0;

  while ((await pending()) > 0) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const drainedMs = Date.now() - t0;

  const throughput = (COUNT / (drainedMs / 1000)).toFixed(1);
  console.log(`\n${COUNT} images`);
  console.log(`  uploaded (all 202s) in : ${uploadedMs} ms`);
  console.log(`  queue fully drained in : ${drainedMs} ms`);
  console.log(`  worker throughput      : ${throughput} img/sec`);

  await queue.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
