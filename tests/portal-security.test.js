const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loginTarget, requestFromPortal, sessionSecret, isPublicAsset} = require('../portal-security');

test('login preserves local destinations and rejects browser-normalized external redirects', () => {
  assert.equal(loginTarget('/raspis-test?tab=pozadavky'), '/raspis-test?tab=pozadavky');
  for (const target of ['//other.invalid', '/\\other.invalid', '/a/..//other.invalid', 'https://other.invalid', '/\n/other.invalid', '/widget', {}]) {
    assert.equal(loginTarget(target), '/portal', JSON.stringify(target));
  }
});

test('same-origin writes and older clients work while cross-origin writes and logout are denied', () => {
  function check(method, path, headers) {
    let result;
    requestFromPortal({method,path,protocol:'https',get: name => ({host:'portal.invalid',...headers})[name]},
      {status: code => ({json: () => {result=code;}})}, () => {result='allowed';});
    return result;
  }
  assert.equal(check('POST','/api/rt/requirements/save',{origin:'https://portal.invalid','sec-fetch-site':'same-origin'}),'allowed');
  assert.equal(check('POST','/login',{}),'allowed');
  assert.equal(check('POST','/login',{origin:'https://other.invalid'}),403);
  assert.equal(check('PATCH','/api/settings',{origin:'null'}),403);
  assert.equal(check('GET','/logout',{'sec-fetch-site':'cross-site'}),403);
  assert.equal(check('GET','/portal',{'sec-fetch-site':'cross-site'}),'allowed');
});

test('production rejects the old fallback key and static delivery excludes historic source bundles', () => {
  assert.equal(sessionSecret({NODE_ENV:'production',SESSION_SECRET:'configured-secret'}),'configured-secret');
  assert.throws(() => sessionSecret({NODE_ENV:'production'}),/SESSION_SECRET/);
  assert.throws(() => sessionSecret({NODE_ENV:'production',SESSION_SECRET:'ave-portal-2026-secret'}),/SESSION_SECRET/);
  assert(isPublicAsset('/theme.js'));
  assert(isPublicAsset('/manifest.json'));
  assert(!isPublicAsset('/ave-portal.zip'));
  assert(!isPublicAsset('/ave-portal/server.js'));
});
