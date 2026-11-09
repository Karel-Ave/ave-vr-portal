'use strict';

const {createHash, randomUUID} = require('node:crypto');
const {isIP} = require('node:net');

const scopes = {
  ip: {limit: 30, seconds: 300},
  pair: {limit: 5, seconds: 900},
  account: {limit: 10, seconds: 900}
};

function bucketKey(scope, ...values) {
  return createHash('sha256').update(JSON.stringify([scope, ...values])).digest('hex');
}

async function reserve(db, scope, key) {
  const {limit, seconds} = scopes[scope];
  const {rows: [row]} = await db.query(`
    INSERT INTO login_attempt_windows AS w (key, attempts, window_id, expires_at)
    VALUES ($1, 1, $2, statement_timestamp() + $3 * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN w.expires_at <= statement_timestamp() THEN 1 ELSE w.attempts + 1 END,
      window_id = CASE WHEN w.expires_at <= statement_timestamp() THEN EXCLUDED.window_id ELSE w.window_id END,
      expires_at = CASE WHEN w.expires_at <= statement_timestamp() THEN EXCLUDED.expires_at ELSE w.expires_at END
    WHERE w.expires_at <= statement_timestamp() OR w.attempts < $4
    RETURNING window_id`,
  [key, randomUUID(), seconds, limit]);
  if (row) return {key, windowId: row.window_id, retryAfter: 0};
  const {rows: [blocked]} = await db.query(`SELECT GREATEST(1,
    CEIL(EXTRACT(EPOCH FROM (expires_at - statement_timestamp())))) AS retry_after
    FROM login_attempt_windows WHERE key = $1`, [key]);
  return {retryAfter: Number(blocked?.retry_after || 1)};
}

async function refund(db, bucket) {
  await db.query(`UPDATE login_attempt_windows SET attempts = GREATEST(0, attempts - 1)
    WHERE key = $1 AND window_id = $2`, [bucket.key, bucket.windowId]);
}

function clientAddress(ip) {
  ip = String(ip || '').split('%')[0];
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return 'unknown';
  const [head, tail] = new URL('http://[' + ip + ']').hostname.slice(1,-1).split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const blocks = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (blocks.slice(0,5).every(block => block === '0') && blocks[5] === 'ffff') {
    return blocks.slice(6).flatMap(block => [parseInt(block,16) >> 8, parseInt(block,16) & 255]).join('.');
  }
  return blocks.slice(0,4).join(':') + '/64';
}

let nextCleanup = 0;
async function reserveLoginAttempt(db, ip, username) {
  if (Date.now() >= nextCleanup) {
    nextCleanup = Date.now() + 15 * 60 * 1000;
    await db.query('DELETE FROM login_attempt_windows WHERE expires_at <= statement_timestamp()');
  }
  const address = clientAddress(ip);
  const login = String(username || '').trim().toLowerCase();
  const ipBucket = await reserve(db, 'ip', bucketKey('ip', address));
  if (ipBucket.retryAfter) return ipBucket;
  if (!login) return {retryAfter: 0, releaseSuccess: async () => {}};
  const pair = await reserve(db, 'pair', bucketKey('pair', address, login));
  if (pair.retryAfter) return pair;
  const account = await reserve(db, 'account', bucketKey('account', login));
  if (account.retryAfter) {
    await refund(db, pair);
    return account;
  }
  return {retryAfter: 0, releaseSuccess: () => Promise.all([refund(db, pair), refund(db, account)])};
}

module.exports = {reserveLoginAttempt};
