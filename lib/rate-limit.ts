type GuardState = {
  sendTimestamps: number[];
  duplicateHashes: Map<string, number>;
};

declare global {
  // Vercel instances do not share memory, so this is defense-in-depth only.
  // eslint-disable-next-line no-var
  var telegramRichMcpGuardState: GuardState | undefined;
}

function getState(): GuardState {
  globalThis.telegramRichMcpGuardState ??= {
    sendTimestamps: [],
    duplicateHashes: new Map<string, number>()
  };
  return globalThis.telegramRichMcpGuardState;
}

export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: "rate_limited" | "duplicate"; retryAfterSeconds: number };

export function checkSendGuard(options: {
  now: number;
  payloadHash: string;
  maxPerMinute: number;
  duplicateWindowSeconds: number;
}): GuardResult {
  const state = getState();
  const minuteAgo = options.now - 60_000;
  state.sendTimestamps = state.sendTimestamps.filter((timestamp) => timestamp > minuteAgo);

  const duplicateWindowMs = options.duplicateWindowSeconds * 1_000;
  for (const [hash, timestamp] of state.duplicateHashes) {
    if (timestamp <= options.now - duplicateWindowMs) state.duplicateHashes.delete(hash);
  }

  if (duplicateWindowMs > 0) {
    const previous = state.duplicateHashes.get(options.payloadHash);
    if (previous !== undefined) {
      return {
        allowed: false,
        reason: "duplicate",
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((previous + duplicateWindowMs - options.now) / 1_000)
        )
      };
    }
  }

  if (state.sendTimestamps.length >= options.maxPerMinute) {
    const oldest = state.sendTimestamps[0] ?? options.now;
    return {
      allowed: false,
      reason: "rate_limited",
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60_000 - options.now) / 1_000))
    };
  }

  return { allowed: true };
}

export function recordSuccessfulSend(options: {
  now: number;
  payloadHash: string;
  duplicateWindowSeconds: number;
}): void {
  const state = getState();
  state.sendTimestamps.push(options.now);
  if (options.duplicateWindowSeconds > 0) {
    state.duplicateHashes.set(options.payloadHash, options.now);
  }
}
