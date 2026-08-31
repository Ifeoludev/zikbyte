import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Backblaze B2's S3-compatible API. Any S3-compatible provider (R2, MinIO,
// real S3) works here unchanged — only the env vars below would need to
// point somewhere else.
//
// No delete/sweep logic here — a bucket lifecycle rule on B2 handles expiry
// instead, so nothing in the app needs to track or clean up old objects.

export const COMPRESSED_PREFIX = "compressed/";

const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

// A function, not a module-level constant: tsx/Node run this file's imports
// with ESM hoisting semantics, so a top-level `const BUCKET = process.env...`
// would capture its value before the entrypoint's dotenv.config() call ever
// runs, regardless of where that call sits in server.ts/worker.ts. Reading
// lazily, at call time, sidesteps that entirely.
function bucketName(): string {
  return process.env.B2_BUCKET ?? "";
}

export function createStorageClient(): S3Client {
  return new S3Client({
    endpoint: process.env.B2_ENDPOINT,
    region: process.env.B2_REGION,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID ?? "",
      secretAccessKey: process.env.B2_APPLICATION_KEY ?? "",
    },
  });
}

export async function putObject(
  client: S3Client,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** A time-limited download link — the API hands this to the client rather than proxying bytes itself. */
export async function getDownloadUrl(
  client: S3Client,
  key: string,
  downloadFilename: string,
): Promise<string> {
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: key,
      ResponseContentDisposition: `attachment; filename="${downloadFilename}"`,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
}

export function compressedKey(hash: string, ext: string): string {
  return `${COMPRESSED_PREFIX}${hash}.${ext}`;
}
