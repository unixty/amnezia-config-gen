// server.js
// Production HTTP server for Docker and standalone deployment.
// Serves static assets from public/ and dispatches /api/* calls to serverless handlers.

/* eslint-disable no-console */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const zlib = require('zlib');

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(__dirname, 'public');

// Load API handlers
const apiRoutes = {
  '/api/warp': require('./api/warp'),
  '/api/iplist': require('./api/iplist'),
  '/api/healthcheck': require('./api/healthcheck'),
  '/api/status': require('./api/status'),
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const COMPRESSIBLE_EXTENSIONS = new Set([
  '.html',
  '.css',
  '.js',
  '.json',
  '.svg',
  '.txt',
  '.xml',
  '.webmanifest',
]);

const applyGlobalSecurityHeaders = (res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    'default-src \'self\'; script-src \'self\' \'unsafe-inline\' https://mc.yandex.ru https://*.vercel-insights.com; style-src \'self\' \'unsafe-inline\' https://fonts.googleapis.com; font-src \'self\' https://fonts.gstatic.com; img-src \'self\' https://mc.yandex.ru https://mc.yandex.com data:; connect-src \'self\' https://mc.yandex.ru https://mc.yandex.com wss://mc.yandex.com https://raw.githubusercontent.com https://*.vercel-insights.com; frame-src \'none\'; frame-ancestors \'self\'; base-uri \'self\'; form-action \'self\'; upgrade-insecure-requests'
  );
};

const parseQueryParams = (searchParams) => {
  const query = {};
  for (const [key, value] of searchParams.entries()) {
    if (query[key] === undefined) {
      query[key] = value;
    } else if (Array.isArray(query[key])) {
      query[key].push(value);
    } else {
      query[key] = [query[key], value];
    }
  }
  return query;
};

const parseJsonBody = (req, maxBytes = 1_048_576) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', reject);
  });

const enhanceResponse = (res) => {
  res.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  res.json = function json(data) {
    if (!this.getHeader('Content-Type')) {
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    this.end(JSON.stringify(data));
    return this;
  };
  res.send = function send(data) {
    this.end(data);
    return this;
  };
};

const resolveStaticFilePath = (pathname) => {
  let target = pathname;
  if (target === '/' || target === '') {
    target = '/index.html';
  }

  // Remove leading slashes and normalize
  const sanitized = path.normalize(target.replace(/^\/+/, ''));
  const candidate = path.resolve(PUBLIC_DIR, sanitized);

  // Prevent path traversal
  if (!candidate.startsWith(PUBLIC_DIR)) {
    return null;
  }

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  // Support clean URLs, e.g. /status -> /status.html
  const withHtml = `${candidate}.html`;
  if (fs.existsSync(withHtml) && fs.statSync(withHtml).isFile()) {
    return withHtml;
  }

  return null;
};

const getCacheControl = (pathname) => {
  if (pathname === '/static/presets-fallback.json') {
    return 'public, max-age=0, must-revalidate';
  }
  if (pathname.startsWith('/static/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=0, must-revalidate';
};

const serveStatic = (req, res, pathname, filePath) => {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', getCacheControl(pathname));

  if (pathname === '/status.json' || pathname === '/status.html') {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', stat.size);
    res.statusCode = 200;
    res.end();
    return;
  }

  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (COMPRESSIBLE_EXTENSIONS.has(ext) && acceptEncoding.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    const gzip = zlib.createGzip();
    fs.createReadStream(filePath).pipe(gzip).pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
  }
};

const handleRequest = async (req, res) => {
  enhanceResponse(res);
  applyGlobalSecurityHeaders(res);

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // Liveness check for Docker and container orchestrators
  if (pathname === '/healthz') {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
    return;
  }

  // Serverless API routing
  if (apiRoutes[pathname]) {
    req.query = parseQueryParams(urlObj.searchParams);

    if (req.method === 'POST') {
      try {
        req.body = await parseJsonBody(req);
      } catch (err) {
        const code = err.statusCode || 400;
        res.status(code).json({
          success: false,
          message: code === 400 ? 'Некорректное JSON-тело запроса.' : err.message,
        });
        return;
      }
    } else {
      req.body = {};
    }

    try {
      await apiRoutes[pathname](req, res);
    } catch (err) {
      console.error(`Unhandled error in ${pathname}:`, err);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'internal_server_error',
          message: err.message,
        });
      }
    }
    return;
  }

  // Disallow non-GET/HEAD methods for static files
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ success: false, message: 'Method not allowed' });
    return;
  }

  // Static file serving
  const filePath = resolveStaticFilePath(pathname);
  if (!filePath) {
    res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8').end('404 Not Found');
    return;
  }

  serveStatic(req, res, pathname, filePath);
};

const server = http.createServer(handleRequest);

const startServer = () => {
  server.listen(PORT, HOST, () => {
    console.log(`[amnezia-config-generator] Server running on http://${HOST}:${PORT}`);
  });
};

const stopServer = () => {
  server.close(() => {
    console.log('[amnezia-config-generator] Server stopped gracefully.');
    process.exit(0);
  });
};

process.on('SIGTERM', stopServer);
process.on('SIGINT', stopServer);

if (require.main === module) {
  startServer();
}

module.exports = { server, handleRequest, resolveStaticFilePath, parseQueryParams };
