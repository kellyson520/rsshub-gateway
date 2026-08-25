import test from 'node:test';
import assert from 'node:assert/strict';
import * as xAdapter from '../src/adapters/x.js';
import * as instagramAdapter from '../src/adapters/instagram.js';
import * as telegramAdapter from '../src/adapters/telegram.js';
import * as pixivAdapter from '../src/adapters/pixiv.js';

// ===== X (Twitter) Adapter 测试 =====

test('xAdapter: matches domain variants', () => {
  assert.equal(xAdapter.matches('x.com'), true);
  assert.equal(xAdapter.matches('api.x.com'), true);
  assert.equal(xAdapter.matches('twitter.com'), true);
  assert.equal(xAdapter.matches('pbs.twimg.com'), true);
  assert.equal(xAdapter.matches('example.com'), false);
});

test('xAdapter: builds headers with credentials only when requested', () => {
  const config = { authToken: 'token123', ct0: 'csrf456' };
  assert.deepEqual(xAdapter.headers(config, { includeCredentials: false }), {});
  assert.deepEqual(xAdapter.headers(config, { includeCredentials: true }), {
    cookie: 'auth_token=token123; ct0=csrf456',
  });
});

test('xAdapter: isAuthenticationChallenge detects 401, redirects and login DOM', () => {
  assert.equal(xAdapter.isAuthenticationChallenge({ status: 401 }), true);
  assert.equal(xAdapter.isAuthenticationChallenge({
    status: 302,
    headers: new Headers({ location: 'https://x.com/i/flow/login' }),
  }), true);
  assert.equal(xAdapter.isAuthenticationChallenge({
    status: 200,
    body: '<form action="/i/flow/login"><input name="password"></form>',
  }), true);
  assert.equal(xAdapter.isAuthenticationChallenge({
    status: 200,
    body: '<article><div data-testid="tweet">A valid tweet content</div></article>',
  }), false);
});

// ===== Instagram Adapter 测试 =====

test('instagramAdapter: matches domain variants', () => {
  assert.equal(instagramAdapter.matches('instagram.com'), true);
  assert.equal(instagramAdapter.matches('scontent.cdninstagram.com'), true);
  assert.equal(instagramAdapter.matches('scontent.fbcdn.net'), true);
  assert.equal(instagramAdapter.matches('meta.com'), false);
});

test('instagramAdapter: builds headers with credentials only when requested', () => {
  const config = { cookie: 'sessionid=insta_sess_789' };
  assert.deepEqual(instagramAdapter.headers(config, { includeCredentials: false }), {});
  assert.deepEqual(instagramAdapter.headers(config, { includeCredentials: true }), {
    cookie: 'sessionid=insta_sess_789',
  });
});

test('instagramAdapter: isAuthenticationChallenge detects 401, redirects and login DOM', () => {
  assert.equal(instagramAdapter.isAuthenticationChallenge({ status: 401 }), true);
  assert.equal(instagramAdapter.isAuthenticationChallenge({
    status: 302,
    headers: { location: 'https://www.instagram.com/accounts/login/' },
  }), true);
  assert.equal(instagramAdapter.isAuthenticationChallenge({
    status: 200,
    body: '<form><input name="username"><input name="password"></form>',
  }), true);
  assert.equal(instagramAdapter.isAuthenticationChallenge({
    status: 200,
    body: '<article><h1>Post title</h1><p>Photo caption</p></article>',
  }), false);
});

// ===== Telegram Adapter 测试 =====

test('telegramAdapter: transforms single message url to embed mode', () => {
  assert.equal(
    telegramAdapter.readerTarget('https://t.me/durov/123'),
    'https://t.me/durov/123?embed=1',
  );
  assert.equal(
    telegramAdapter.readerTarget('https://t.me/s/durov'),
    'https://t.me/s/durov',
  );
});

test('telegramAdapter: matches and challenge behavior', () => {
  assert.equal(telegramAdapter.matches('t.me'), true);
  assert.equal(telegramAdapter.matches('web.t.me'), true);
  assert.equal(telegramAdapter.matches('telegram.org'), false);
  assert.equal(telegramAdapter.isAuthenticationChallenge(), false);
});

// ===== Pixiv Adapter 测试 =====

test('pixivAdapter: matches domains and sets referer header', () => {
  assert.equal(pixivAdapter.matches('pixiv.net'), true);
  assert.equal(pixivAdapter.matches('i.pximg.net'), true);
  assert.equal(pixivAdapter.matches('pximg.net'), true);
  assert.equal(pixivAdapter.matches('fanbox.cc'), false);

  const anonymous = pixivAdapter.headers({});
  assert.equal(anonymous.referer, 'https://www.pixiv.net/');

  const authenticated = pixivAdapter.headers({ cookie: 'PHPSESSID=123' }, { includeCredentials: true });
  assert.equal(authenticated.cookie, 'PHPSESSID=123');
  assert.equal(authenticated.referer, 'https://www.pixiv.net/');
});
