import { z } from "zod";
import path from "node:path";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_BASE_URL: z.string().url().default("http://localhost:5173"),
  API_BASE_URL: z.string().url().default("http://localhost:3001"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_PATH: z.string().default("./private-uploads"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(10 * 1024 * 1024).default(5 * 1024 * 1024),
  S3_ENDPOINT: z.string().url().optional().or(z.literal("")),
  S3_REGION: z.string().default("ap-southeast-1"),
  S3_BUCKET: z.string().optional().or(z.literal("")),
  S3_ACCESS_KEY_ID: z.string().optional().or(z.literal("")),
  S3_SECRET_ACCESS_KEY: z.string().optional().or(z.literal("")),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  NOTIFICATION_DRIVER: z.enum(["console", "smtp"]).default("console"),
  SMTP_HOST: z.string().optional().or(z.literal("")),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_USER: z.string().optional().or(z.literal("")),
  SMTP_PASSWORD: z.string().optional().or(z.literal("")),
  EMAIL_FROM: z.string().optional().or(z.literal("")),
  MANAGER_EMAIL: z.string().email().optional().or(z.literal("")),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(env);
  if (value.NODE_ENV === "production" && value.STORAGE_DRIVER === "local") {
    throw new Error("Production requires STORAGE_DRIVER=s3; local uploads are not deployment-safe.");
  }
  if (value.STORAGE_DRIVER === "s3" && (!value.S3_BUCKET || !value.S3_ACCESS_KEY_ID || !value.S3_SECRET_ACCESS_KEY)) {
    throw new Error("S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY are required for S3 storage.");
  }
  if (value.NODE_ENV === "production" && value.NOTIFICATION_DRIVER === "console") {
    throw new Error("Production requires NOTIFICATION_DRIVER=smtp.");
  }
  if (value.NOTIFICATION_DRIVER === "smtp" && (!value.SMTP_HOST || !value.EMAIL_FROM)) {
    throw new Error("SMTP_HOST and EMAIL_FROM are required for SMTP notifications.");
  }
  return {
    ...value,
    isProduction: value.NODE_ENV === "production",
    databaseSsl: value.DATABASE_SSL === "true",
    trustProxy: value.TRUST_PROXY === "true",
    smtpSecure: value.SMTP_SECURE === "true",
    s3ForcePathStyle: value.S3_FORCE_PATH_STYLE === "true",
    localStoragePath: path.resolve(process.cwd(), value.LOCAL_STORAGE_PATH),
  };
}
