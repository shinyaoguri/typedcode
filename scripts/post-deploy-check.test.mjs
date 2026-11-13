import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { checkDeployment } from './post-deploy-check.mjs';

const config = {
  pagesUrl: 'https://pages.test',
  apiUrl: 'https://api.test',
  origins: ['https://pages.test', 'https://alias.test'],
};
function response(url, init) {
  if (url.pathname === '/health') return Response.json({ status: 'ok', signing: { ok: true } });
  if (init.method === 'OPTIONS')
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': init.headers.Origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  return new Response('page', {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' },
  });
}

describe('post-deploy checks', () => {
  it('checks both Pages routes, signing health and every Origin with bounded requests', async () => {
    const calls = [];
    await checkDeployment(config, async (url, init) => {
      calls.push([url.href, init]);
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      return response(url, init);
    });
    assert.deepEqual(
      calls.map(([url]) => url),
      [
        'https://pages.test/',
        'https://pages.test/verify/',
        'https://api.test/health',
        'https://api.test/api/checkpoint/sign',
        'https://api.test/api/checkpoint/sign',
      ]
    );
    assert.deepEqual(
      calls.slice(3).map(([, init]) => init.headers),
      config.origins.map((origin) => ({
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      }))
    );
  });

  for (const path of ['/', '/verify/']) {
    for (const header of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy']) {
      for (const invalid of [null, 'unsafe-none']) {
        it(`rejects ${path} with ${header}=${invalid}`, async () => {
          await assert.rejects(
            checkDeployment(config, async (url, init) => {
              const res = response(url, init);
              if (url.pathname === path) {
                if (invalid === null) res.headers.delete(header);
                else res.headers.set(header, invalid);
              }
              return res;
            }),
            /COOP|COEP/
          );
        });
      }
    }
  }
  for (const body of [
    { status: 'ok' },
    { status: 'ok', signing: { ok: false } },
    { status: 'error', signing: { ok: true } },
  ]) {
    it(`rejects an unhealthy signing response ${JSON.stringify(body)}`, async () => {
      await assert.rejects(
        checkDeployment(config, async (url, init) =>
          url.pathname === '/health' ? Response.json(body) : response(url, init)
        ),
        /signing is not ready/
      );
    });
  }
  for (const header of [
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Methods',
    'Access-Control-Allow-Headers',
  ]) {
    it(`rejects a missing ${header} on the second Origin`, async () => {
      await assert.rejects(
        checkDeployment(config, async (url, init) => {
          const res = response(url, init);
          if (init.headers?.Origin === config.origins[1]) res.headers.delete(header);
          return res;
        }),
        /CORS/
      );
    });
  }
  it('rejects wildcard CORS', async () => {
    await assert.rejects(
      checkDeployment(config, async (url, init) => {
        const res = response(url, init);
        if (init.method === 'OPTIONS') res.headers.set('Access-Control-Allow-Origin', '*');
        return res;
      }),
      /CORS/
    );
  });
  for (const path of ['/', '/verify/', '/health', '/api/checkpoint/sign']) {
    it(`rejects HTTP failure on ${path}`, async () => {
      await assert.rejects(
        checkDeployment(config, async (url, init) =>
          url.pathname === path ? new Response(null, { status: 503 }) : response(url, init)
        ),
        /HTTP 503/
      );
    });
  }
  it('rejects network failure, malformed health JSON and an empty Origin list', async () => {
    await assert.rejects(
      checkDeployment(config, async () => {
        throw new Error('offline');
      }),
      /offline/
    );
    await assert.rejects(
      checkDeployment(config, async (url, init) =>
        url.pathname === '/health' ? new Response('not-json') : response(url, init)
      ),
      SyntaxError
    );
    await assert.rejects(checkDeployment({ ...config, origins: [] }), /Origin/);
  });
});

it('CLI exits nonzero for each failed deployment check, and zero for a healthy deployment', async (t) => {
  let failure = '';
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', signing: { ok: failure !== 'health' } }));
    } else if (req.method === 'OPTIONS') {
      if (failure !== 'cors') res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204).end();
    } else {
      if (failure !== 'headers') res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      res.end('page');
    }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (failure of ['', 'headers', 'health', 'cors']) {
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/post-deploy-check.mjs'], {
        env: { ...process.env, PAGES_URL: base, API_URL: base, CHECK_ORIGINS: base },
        stdio: 'pipe',
      });
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(exit, failure ? 1 : 0, failure || 'healthy');
  }
});
