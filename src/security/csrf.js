'use strict';
const crypto = require('node:crypto');
const COOKIE_PREFIX = 'sdc_';
function cookieName(scope) {
  if (scope !== 'patient' && scope !== 'doctor' && scope !== 'admin' && scope !== 'login') throw new Error('Unsupported CSRF scope');
  return COOKIE_PREFIX + scope + '_csrf';
}
const TTL_SECONDS = 30 * 60;
const key = process.env.CSRF_SECRET || crypto.randomBytes(32).toString('hex');
if (process.env.NODE_ENV === 'production' && (!process.env.CSRF_SECRET || process.env.CSRF_SECRET.length < 32)) {
  throw new Error('Set CSRF_SECRET to a stable random secret of at least 32 chars in production.');
}
function hmac(payload) { return crypto.createHmac('sha256', key).update(payload).digest('hex'); }
function safeEqual(a, b) {
  const left = Buffer.from(String(a || '')); const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function parseCookie(req, scope) {
  const name = cookieName(scope);
  const pair = String(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  return pair ? pair.slice(name.length + 1) : '';
}
function issueCsrf(res, scope = 'patient') {
  const name = cookieName(scope);
  const token = crypto.randomBytes(32).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = `${token}.${timestamp}`;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=${payload}.${hmac(payload)}; Max-Age=${TTL_SECONDS}; Path=${scope === 'admin' ? '/admin' : scope === 'login' ? '/auth' : '/auth/register/' + scope}; HttpOnly; SameSite=Lax${secure}`);
  return token;
}
function validateCsrf(req, scope = 'patient') {
  const formToken = req.body && req.body.csrf_token;
  const [token, timestamp, signature, extra] = parseCookie(req, scope).split('.');
  if (extra !== undefined || !/^[a-f0-9]{64}$/.test(token || '') || !/^\d{10,}$/.test(timestamp || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  const issued = Number(timestamp); const now = Math.floor(Date.now() / 1000);
  return now >= issued && now - issued <= TTL_SECONDS && safeEqual(formToken, token) && safeEqual(signature, hmac(`${token}.${timestamp}`));
}
module.exports = { issueCsrf, validateCsrf };
