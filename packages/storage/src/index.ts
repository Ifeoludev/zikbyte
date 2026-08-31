import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Backblaze B2's S3-compatible API. Any S3-compatible provider (R2, MinIO,
// real S3) works here unchanged — only the env vars below would need to
// point somewhere else.

export const UPLOADS_PREFIX = "uploads/";
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

export async function getObject(client: S3Client, key: string): Promise<Buffer> {
  const { Body } = await client.send(
    new GetObjectCommand({ Bucket: bucketName(), Key: key }),
  );
  if (!Body) throw new Error(`Object not found: ${key}`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function deleteObject(client: S3Client, key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
}

/**
 * Deletes every object under a prefix. Used by the expiry sweep so cleanup
 * doesn't depend on the BullMQ job record still existing — it self-heals even
 * if that record was already reaped by removeOnComplete's own age-based TTL.
 */
export async function deleteObjectsByPrefix(
  client: S3Client,
  prefix: string,
): Promise<void> {
  const { Contents } = await client.send(
    new ListObjectsV2Command({ Bucket: bucketName(), Prefix: prefix }),
  );
  if (!Contents?.length) return;
  await Promise.all(
    Contents.filter((obj) => obj.Key).map((obj) => deleteObject(client, obj.Key!)),
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

export function uploadKey(hash: string, ext: string): string {
  return `${UPLOADS_PREFIX}${hash}${ext}`;
}

export function compressedKey(hash: string, ext: string): string {
  return `${COMPRESSED_PREFIX}${hash}.${ext}`;
}
