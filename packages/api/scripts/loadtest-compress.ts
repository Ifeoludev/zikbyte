import fs from "node:fs";
import path from "node:path";
import autocannon from "autocannon";
import FormData from "form-data";
import sharp from "sharp";

const FIXTURE_PATH = path.join(__dirname, "fixtures", "test-image.jpg");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const connections = Number(arg("--connections", "10"));
const duration = Number(arg("--duration", "10"));
const url = arg("--url", "http://localhost:4000/api/compress");

async function ensureFixture() {
  if (fs.existsSync(FIXTURE_PATH)) return;
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  // A large-ish synthetic photo so compression is actually CPU work worth measuring,
  // not a trivial no-op sharp finishes before it even hits the thread pool queue.
  await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: { r: 90, g: 140, b: 200 } },
  })
    .jpeg({ quality: 100 })
    .toFile(FIXTURE_PATH);
  console.log(`Created fixture image at ${FIXTURE_PATH}`);
}

async function main() {
  await ensureFixture();

  const form = new FormData();
  form.append("image", fs.readFileSync(FIXTURE_PATH), {
    filename: "test-image.jpg",
    contentType: "image/jpeg",
  });

  console.log(`Load-testing ${url} — connections=${connections}, duration=${duration}s\n`);

  const result = await autocannon({
    url,
    method: "POST",
    connections,
    duration,
    headers: form.getHeaders(),
    body: form.getBuffer(),
  });

  console.log(autocannon.printResult(result));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
