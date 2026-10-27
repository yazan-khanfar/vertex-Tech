'use strict';
// Simple per-process limit for the local development server; use shared storage/proxy limits in production.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function limited(req, res, next, scope) {
  const now = Date.now();
  if (attempts.size > 2000) { for (const [k, v] of attempts) if (v.start + WINDOW_MS < now) attempts.delete(k); }
  const key = scope + ':' + (req.ip || req.socket.remoteAddress || 'unknown');
  const previous = attempts.get(key);
  const entry = !previous || now - previous.start >= WINDOW_MS ? { start: now, count: 0 } : previous;
  entry.count++; attempts.set(key, entry);
  if (entry.count > 10) { res.setHeader('Retry-After', String(Math.ceil((entry.start + WINDOW_MS - now) / 1000))); return res.status(429).type('text/plain').send('محاولات كثيرة. حاول مجددًا بعد قليل.'); }
  next();
}
function limitPatientRegistration(req, res, next) { return limited(req, res, next, 'patient'); }
function limitDoctorRegistration(req, res, next) { return limited(req, res, next, 'doctor'); }
module.exports = { limitPatientRegistration, limitDoctorRegistration };
