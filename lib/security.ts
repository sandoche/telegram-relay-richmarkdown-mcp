import { createHash, timingSafeEqual } from "node:crypto";

const URL_SAFE_SECRET = /^[A-Za-z0-9_-]+$/;

export function isStrongAccessToken(value: string | undefined): value is string {
  return Boolean(value && value.length >= 32 && URL_SAFE_SECRET.test(value));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

export function readIntegerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}
