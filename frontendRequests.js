export const DASHBOARD_PAGE_LIMITS = {
  playersLimit: 500,
  transactionsLimit: 100,
};

export function createRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildRunBody(functionName, args, requestId) {
  const body = { functionName, args };
  if (requestId) body.requestId = requestId;
  return body;
}

export function isSupportedFinalTime(value) {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) return false;
  return Math.abs(seconds * 10 - Math.round(seconds * 10)) < 1e-6;
}
