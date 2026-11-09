'use strict';

const {randomBytes} = require('node:crypto');

function sessionSecret(env) {
  const secret = env.SESSION_SECRET;
  if (secret && secret !== 'ave-portal-2026-secret') return secret;
  if (env.NODE_ENV === 'production') throw new Error('Nastavte vlastní SESSION_SECRET pro produkci.');
  return randomBytes(32).toString('hex');
}

function loginTarget(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\x00-\x20\x7f]/.test(value)) return '/portal';
  const localOrigin = 'https://portal.invalid';
  try {
    const target = new URL(value, localOrigin);
    if (target.origin === localOrigin && !target.pathname.startsWith('//') && target.pathname !== '/widget') {
      return target.pathname + target.search + target.hash;
    }
  } catch (_) {}
  return '/portal';
}

function requestFromPortal(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path !== '/logout') return next();
  const origin = req.get('origin');
  let allowedOrigin = !origin;
  if (origin) {
    try { allowedOrigin = new URL(origin).origin === new URL(`${req.protocol}://${req.get('host')}`).origin; }
    catch (_) { allowedOrigin = false; }
  }
  if (allowedOrigin && req.get('sec-fetch-site') !== 'cross-site') return next();
  return res.status(403).json({ok: false, msg: 'Požadavek nepřišel z portálu.'});
}

function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Content-Security-Policy-Report-Only', "script-src 'self'; object-src 'none'; base-uri 'self'");
  next();
}

function isPublicAsset(path) {
  return /^\/[a-z0-9][a-z0-9-]*\.(?:js|css|png|json)$/i.test(path);
}

function protectStaticFiles(req, res, next) {
  let asset;
  try { asset = decodeURIComponent(req.path).toLowerCase(); }
  catch (_) { return res.sendStatus(400); }
  if (!isPublicAsset(asset)) {
    if (!/^\/(?:blacklist|raspis|rozpis|rozpis-recep|rozpis_fixed)\.html$/.test(asset)) return res.sendStatus(404);
    if (!req.session?.user) return res.redirect('/');
  }
  next();
}

module.exports = {sessionSecret, loginTarget, requestFromPortal, securityHeaders, isPublicAsset, protectStaticFiles};
