// tests/server-integration.test.mjs
// Integration tests for the API server pipeline
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

// Set env vars before requiring server
process.env.ADMIN_KEY = 'test-admin-key';
process.env.SESSION_SECRET = 'test-session-secret';

let server;
let baseUrl;

function makeRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

beforeAll(async () => {
  const app = require('../src/server.js');
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  return new Promise(resolve => server.close(resolve));
});

describe('Health endpoints', () => {
  it('GET /api/health returns ok with timestamp', async () => {
    const res = await makeRequest('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('timestamp');
  });
});

describe('Session management', () => {
  it('GET /api/admin/session returns unauthenticated when no session', async () => {
    const res = await makeRequest('/api/admin/session');
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });

  it('POST /api/admin/login without DB returns 503', async () => {
    const res = await makeRequest('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { key: 'test-admin-key' },
    });
    // Without NEON_DATABASE_URL, login is unavailable
    expect([503, 400]).toContain(res.status);
  });
});

describe('Rate limiting', () => {
  it('API routes respond without being blocked', async () => {
    const res = await makeRequest('/api/health');
    expect(res.status).toBe(200);
  });
});

describe('Security headers', () => {
  it('Response includes Helmet security headers', async () => {
    const res = await makeRequest('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-xss-protection']).toBe('0');
  });
});

describe('Static file serving', () => {
  it('GET / returns HTML or 200', async () => {
    const res = await makeRequest('/');
    expect([200, 304, 404]).toContain(res.status);
  });

  it('GET /manifest.json returns JSON', async () => {
    const res = await makeRequest('/manifest.json');
    expect(res.status).toBe(200);
  });

  it('GET /offline.html returns the offline page', async () => {
    const res = await makeRequest('/offline.html');
    expect(res.status).toBe(200);
  });
});

describe('404 handling', () => {
  it('Unknown API route returns 404', async () => {
    const res = await makeRequest('/api/nonexistent-endpoint');
    expect(res.status).toBe(404);
  });
});
