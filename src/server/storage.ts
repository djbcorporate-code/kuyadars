import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "./config.js";

export const ACCEPTED_UPLOAD_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;

function hasExpectedSignature(buffer: Buffer, contentType: string): boolean {
  if (contentType === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (contentType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (contentType === "application/pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  return false;
}

export type StoredObject = { storageKey: string; sha256: string; scanStatus: "unavailable" };

export class PrivateStorage {
  private readonly s3?: S3Client;
  constructor(private readonly config: AppConfig) {
    if (config.STORAGE_DRIVER === "s3") {
      this.s3 = new S3Client({
        region: config.S3_REGION,
        endpoint: config.S3_ENDPOINT || undefined,
        forcePathStyle: config.s3ForcePathStyle,
        credentials: { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
      });
    }
  }

  validate(buffer: Buffer, contentType: string) {
    if (!ACCEPTED_UPLOAD_TYPES.includes(contentType as (typeof ACCEPTED_UPLOAD_TYPES)[number])) throw new Error("Only JPEG, PNG, or PDF files are accepted.");
    if (!hasExpectedSignature(buffer, contentType)) throw new Error("File contents do not match the declared type.");
    if (buffer.length === 0 || buffer.length > this.config.MAX_UPLOAD_BYTES) throw new Error("Upload size is invalid.");
  }

  async put(buffer: Buffer, contentType: string, purpose: string): Promise<StoredObject> {
    this.validate(buffer, contentType);
    const storageKey = `${purpose}/${new Date().getUTCFullYear()}/${randomUUID()}`;
    if (this.config.STORAGE_DRIVER === "s3") {
      await this.s3!.send(new PutObjectCommand({ Bucket: this.config.S3_BUCKET!, Key: storageKey, Body: buffer, ContentType: contentType, ServerSideEncryption: "AES256" }));
    } else {
      const target = path.join(this.config.localStoragePath, storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buffer, { flag: "wx" });
    }
    return { storageKey, sha256: createHash("sha256").update(buffer).digest("hex"), scanStatus: "unavailable" };
  }

  async get(storageKey: string): Promise<Buffer> {
    if (this.config.STORAGE_DRIVER === "s3") {
      const result = await this.s3!.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET!, Key: storageKey }));
      return Buffer.from(await result.Body!.transformToByteArray());
    }
    const resolved = path.resolve(this.config.localStoragePath, storageKey);
    const root = path.resolve(this.config.localStoragePath) + path.sep;
    if (!resolved.startsWith(root)) throw new Error("Invalid storage key");
    return readFile(resolved);
  }
}
