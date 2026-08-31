import sharp, { type Sharp } from "sharp";

export interface CompressImageInput {
  /** Raw image bytes. */
  input: Buffer;
  /** JPEG/WebP/AVIF quality, 1-100. */
  quality?: number;
  /** Longest edge, in pixels. Images are never upscaled. */
  maxDimension?: number;
}

export interface CompressImageResult {
  output: Buffer;
  format: OutputFormat;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  savedPercent: number;
}

const DEFAULT_QUALITY = 80;
const DEFAULT_MAX_DIMENSION = 2048;

/**
 * Compresses a single image, bytes in and bytes out. This is the one seam the
 * whole system is built around: called directly from the API route in Phase 1,
 * and by a background worker since Phase 2, with no change to this function
 * itself. Working in Buffers rather than file paths keeps it storage-agnostic —
 * callers own where the bytes come from and go.
 */
export async function compressImage({
  input,
  quality = DEFAULT_QUALITY,
  maxDimension = DEFAULT_MAX_DIMENSION,
}: CompressImageInput): Promise<CompressImageResult> {
  const image = sharp(input, { limitInputPixels: 268402689 }).rotate();

  const metadata = await image.metadata();
  const originalSizeBytes = input.length;

  const resized = image.resize({
    width: maxDimension,
    height: maxDimension,
    fit: "inside",
    withoutEnlargement: true,
  });

  const format = resolveOutputFormat(metadata.format);
  const encoded = applyEncoding(resized, format, quality);
  const output = await encoded.toBuffer();

  const compressedSizeBytes = output.length;
  const savedPercent = originalSizeBytes
    ? Math.round((1 - compressedSizeBytes / originalSizeBytes) * 100)
    : 0;

  return { output, format, originalSizeBytes, compressedSizeBytes, savedPercent };
}

export type OutputFormat = "jpeg" | "png" | "webp";

function resolveOutputFormat(inputFormat: string | undefined): OutputFormat {
  if (inputFormat === "png") return "png";
  if (inputFormat === "webp") return "webp";
  return "jpeg";
}

function applyEncoding(pipeline: Sharp, format: OutputFormat, quality: number) {
  switch (format) {
    case "png":
      return pipeline.png({ quality, compressionLevel: 9 });
    case "webp":
      return pipeline.webp({ quality });
    case "jpeg":
    default:
      return pipeline.jpeg({ quality, mozjpeg: true });
  }
}

export function extensionFor(format: OutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

export function contentTypeFor(format: OutputFormat): string {
  return `image/${format}`;
}
