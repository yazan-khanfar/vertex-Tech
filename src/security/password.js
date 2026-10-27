'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
// A versioned, salted password hash. Never keep plaintext passwords in PostgreSQL.
const OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, OPTIONS);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  try {
    const [scheme, n, r, p, saltHex, hashHex] = encoded.split('$');
    if (scheme !== 'scrypt' || n !== '32768' || r !== '8' || p !== '1' || !/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{128}$/.test(hashHex)) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, OPTIONS);
    return crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}
module.exports = { hashPassword, verifyPassword };
