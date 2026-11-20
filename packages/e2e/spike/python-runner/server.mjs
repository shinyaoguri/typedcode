// Python runner 隔離の PoC (#719 / #650): 本番と同じヘッダ (packages/editor/public/_headers) で
// 親のページと、別 origin の runner (別ポート) を配る小さな静的サーバ。
//   node spike/python-runner/server.mjs <親のポート> <runner のポート>
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const [parentPort, runnerPort] = process.argv.slice(2).map(Number);

const PARENT_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>spike parent</title></head><body></body></html>';
const RUNNER_HTML =
  '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
  '<script src="/probe.js"></script><script src="/runner.js"></script></body></html>';

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };

function serve(port, isRunner) {
  createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    // 本番の _headers と同じ
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    if (isRunner) res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    try {
      if (path === '/' || path === '/index.html') {
        res.setHeader('Content-Type', TYPES['.html']);
        return res.end(PARENT_HTML);
      }
      if (path === '/runner.html') {
        res.setHeader('Content-Type', TYPES['.html']);
        return res.end(RUNNER_HTML);
      }
      if (/^\/[a-z]+\.js$/.test(path)) {
        res.setHeader('Content-Type', TYPES['.js']);
        return res.end(await readFile(join(root, path)));
      }
      res.statusCode = 404;
      res.end('not found');
    } catch {
      res.statusCode = 500;
      res.end('error');
    }
  }).listen(port);
}

serve(parentPort, false);
if (runnerPort) serve(runnerPort, true);
