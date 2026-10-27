'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { getPool } = require('../../db/pool');
const { resolveSession } = require('../auth/guard');
const { validateSessionCsrf } = require('../auth/session');
const { validPassword, changePassword } = require('./service');
const { passwordError, profilePath } = require('./profile-destinations');
const router = express.Router();
const body = express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 7 });
const attempts = new Map();

function returnToProfile(req, res, code, reference) {
  const path = profilePath(req.sdcActor, req.body?.profile_scope, req.sdcSession, req.sdcClinics);
  const params = new URLSearchParams();
  if (code) params.set('password_error', code);
  if (reference) params.set('password_reference', reference);
  return res.redirect(303, path + (params.size ? `?${params}` : '') + '#sdc-password');
}
router.use(async (req, res, next) => {
  try {
    if (!await resolveSession(req, res)) return res.redirect(303, '/auth/login');
    next();
  } catch (error) { next(error); }
});
router.get('/', (req, res) => returnToProfile(req, res, ''));
router.post('/', body, async (req, res) => {
  if (!validateSessionCsrf(req)) return returnToProfile(req, res, 'csrf');
  const key = String(req.sdcActor.userId), now = Date.now(), previous = attempts.get(key);
  const state = previous && now - previous.at < 15 * 60 * 1000 ? previous : { at: now, n: 0 };
  state.n++; attempts.set(key, state);
  if (state.n > 8) return returnToProfile(req, res, 'attempts');
  if (!validPassword(req.body?.new_password) || req.body.new_password !== req.body?.confirm_password)
    return returnToProfile(req, res, 'invalid');
  try {
    const changed = await changePassword(getPool(), req.sdcActor.userId, req.body?.current_password, req.body?.new_password);
    if (!changed) return returnToProfile(req, res, 'current');
    attempts.delete(key);
    // All sessions are invalid after success; the next login still requires MFA.
    return res.redirect(303, '/auth/login?password_changed=1');
  } catch (error) {
    const reference = crypto.randomBytes(4).toString('hex').toUpperCase();
    // Correlation-only metadata. Never log passwords, tokens, cookie values, SQL parameters or connection strings.
    console.error('[PASSWORD_CHANGE_FAILED]', {
      reference,
      phase: error?.passwordChangePhase || 'unknown',
      code: typeof error?.code === 'string' ? error.code : 'NO_DB_CODE',
      table: typeof error?.table === 'string' ? error.table : undefined,
      constraint: typeof error?.constraint === 'string' ? error.constraint : undefined,
      message: error?.code ? undefined : 'Unexpected backend failure'
    });
    return returnToProfile(req, res, 'unavailable', reference);
  }
});
module.exports = router;
