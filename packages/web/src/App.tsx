import { useState, type FormEvent } from "react";

interface CompressResult {
  downloadUrl: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  savedPercent: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "compressing" }
  | { kind: "error"; message: string }
  | { kind: "done"; result: CompressResult };

// Unset locally — Vite's dev proxy makes relative /api/* calls reach the api
// on the same origin. In production the static site and api are on different
// Render domains, so this gets baked in at build time to the api's real URL.
const API_BASE_URL = import.meta.env.VITE_API_URL ?? "";

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;

    setStatus({ kind: "compressing" });

    const formData = new FormData();
    formData.append("image", file);

    try {
      const res = await fetch(`${API_BASE_URL}/api/compress`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ kind: "error", message: data.error ?? "Upload failed." });
        return;
      }
      setStatus({ kind: "done", result: data as CompressResult });
    } catch {
      setStatus({ kind: "error", message: "Upload failed." });
    }
  }

  const busy = status.kind === "compressing";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center gap-6 px-4 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-neutral-900">ZikByte</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Upload an image, get a smaller one back.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="w-full rounded-lg border-2 border-dashed border-neutral-300 p-8 text-center"
      >
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-neutral-600 file:mr-4 file:rounded-md file:border-0 file:bg-neutral-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white"
        />
        <button
          type="submit"
          disabled={!file || busy}
          className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Compressing…" : "Compress"}
        </button>
      </form>

      {status.kind === "error" && (
        <p className="text-sm text-red-600">{status.message}</p>
      )}

      {status.kind === "done" && (
        <div className="w-full rounded-lg border border-neutral-200 p-4 text-center text-sm">
          <p className="text-neutral-700">
            Saved {status.result.savedPercent}% (
            {status.result.originalSizeBytes} →{" "}
            {status.result.compressedSizeBytes} bytes)
          </p>
          <a
            href={status.result.downloadUrl}
            download
            className="mt-2 inline-block font-medium text-neutral-900 underline"
          >
            Download compressed image
          </a>
        </div>
      )}
    </main>
  );
}
