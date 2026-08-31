import { useEffect, useRef, useState, type FormEvent } from "react";

interface CompressResult {
  downloadUrl: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  savedPercent: number;
}

type Status = //status state
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "processing" }
  | { kind: "error"; message: string }
  | { kind: "done"; result: CompressResult };

interface JobStatusResponse {
  status: "processing" | "done" | "failed" | "expired" | "not_found";
  result?: CompressResult;
  error?: string;
}

const POLL_INTERVAL_MS = 1000;
const MAX_POLLS = 120; // ~2 minutes before we give up

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const cancelledRef = useRef(false);

  // If the component unmounts mid-poll, stop touching state.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;

    cancelledRef.current = false;
    setStatus({ kind: "uploading" });

    const formData = new FormData();
    formData.append("image", file);

    let jobId: string;
    try {
      const res = await fetch("/api/compress", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ kind: "error", message: data.error ?? "Upload failed." });
        return;
      }
      jobId = data.jobId;
    } catch {
      setStatus({ kind: "error", message: "Upload failed." });
      return;
    }

    setStatus({ kind: "processing" });
    void pollUntilDone(jobId);
  }

  async function pollUntilDone(jobId: string) {
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (cancelledRef.current) return;

      let data: JobStatusResponse;
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        data = (await res.json()) as JobStatusResponse;
      } catch {
        continue; // transient network blip — try again next tick
      }

      if (data.status === "done" && data.result) {
        setStatus({ kind: "done", result: data.result });
        return;
      }
      if (data.status !== "processing") {
        setStatus({
          kind: "error",
          message: data.error ?? "Compression failed.",
        });
        return;
      }
    }
    setStatus({ kind: "error", message: "Timed out waiting for compression." });
  }

  const busy = status.kind === "uploading" || status.kind === "processing";
  const buttonLabel =
    status.kind === "uploading"
      ? "Uploading…"
      : status.kind === "processing"
        ? "Compressing…"
        : "Compress";

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
          {buttonLabel}
        </button>
      </form>

      {status.kind === "processing" && (
        <p className="text-sm text-neutral-500">Working on it…</p>
      )}

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
