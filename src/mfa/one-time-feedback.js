'use strict';
// PRG feedback is kept outside the persistent session and database. Recovery
// codes remain in RAM for at most two minutes, are delivered once, and are
// never placed in URLs, cookies, logs, or browser storage.
const feedback = new Map();
const TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 1000;
function keyFor(req) {
  const key = req?.sdcSession?.tokenHash;
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('An authenticated tracked session is required for MFA feedback');
  return key;
}
function clean(now = Date.now()) {
  for (const [key,item] of feedback) if (item.expires <= now) feedback.delete(key);
}
function put(req, detail) {
  const key = keyFor(req);
  clean();
  if (!feedback.has(key) && feedback.size >= MAX_PENDING) throw new Error('MFA feedback capacity reached');
  const payload = {
    message: typeof detail?.message === 'string' ? detail.message : '',
    error: typeof detail?.error === 'string' ? detail.error : '',
    codes: Array.isArray(detail?.codes) ? [...detail.codes] : null
  };
  feedback.set(key, {expires:Date.now()+TTL_MS,payload});
  // Expire abandoned one-time secrets even when no further requests arrive.
  // The cleanup closure holds only the session hash, not the recovery codes.
  const cleanup=setTimeout(() => {
    const item=feedback.get(key);
    if (item && item.expires <= Date.now()) feedback.delete(key);
  }, TTL_MS+25);
  cleanup.unref?.();
}
function take(req) {
  const key = keyFor(req);
  const item = feedback.get(key);
  feedback.delete(key);
  return item && item.expires > Date.now() ? item.payload : null;
}
module.exports = {put,take};
