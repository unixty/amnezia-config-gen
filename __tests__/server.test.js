// __tests__/server.test.js
// Tests for the standalone HTTP server (server.js) used in Docker.

'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const http = require('node:http');
const { server } = require('../server');

let testPort = 0;
let baseUrl = '';

const request = (path, options = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          // ignore non-json
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json,
        });
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });

before(() =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      testPort = server.address().port;
      baseUrl = `http://127.0.0.1:${testPort}`;
      resolve();
    });
  })
);

after(() =>
  new Promise((resolve) => {
    server.close(resolve);
  })
);

test('GET /healthz returns 200 and ok status', async () => {
  const res = await request('/healthz');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json?.status, 'ok');
  assert.equal(typeof res.json?.uptime, 'number');
});

test('GET / serves index.html with proper security headers', async () => {
  const res = await request('/');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy']);
  assert.match(res.body, /<title>/);
});

test('GET /static/styles.css serves CSS with immutable cache header', async () => {
  const res = await request('/static/styles.css');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/css/);
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('GET /api/iplist returns presets without error', async () => {
  const res = await request('/api/iplist');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json?.success, true);
  assert.ok(Array.isArray(res.json?.presets));
  assert.ok(res.json?.presets.length > 0);
});

test('POST /api/warp with invalid JSON returns 400', async () => {
  const res = await request('/api/warp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not-valid-json',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json?.success, false);
});

test('GET /unknown-file returns 404', async () => {
  const res = await request('/does-not-exist.txt');
  assert.equal(res.statusCode, 404);
});

test('Path traversal attempt returns 404', async () => {
  const res = await request('/../../package.json');
  assert.equal(res.statusCode, 404);
});
