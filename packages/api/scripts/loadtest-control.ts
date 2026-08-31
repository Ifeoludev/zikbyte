import autocannon from "autocannon";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const connections = Number(arg("--connections", "20"));
const duration = Number(arg("--duration", "10"));
const url = arg("--url", "http://localhost:4000/api/health");

// Hits a route that touches neither the filesystem nor the thread pool — pure JS
// in, JSON out. Run this *while* loadtest-compress.ts is hammering /api/compress
// to see whether a completely unrelated route slows down too, or stays fast.
async function main() {
  console.log(`Load-testing ${url} — connections=${connections}, duration=${duration}s\n`);
  const result = await autocannon({ url, connections, duration });
  console.log(autocannon.printResult(result));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
