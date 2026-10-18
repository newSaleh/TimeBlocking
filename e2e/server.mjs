// Serves the built site (as GitHub Pages would) plus /claude.html: the same
// page with a test double of the claude.ai runtime and a tiny JSON store.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };

export function startServer(port = 4173) {
  const docs = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/claude.html') {
      const page = readFileSync('dist/standalone.html', 'utf8').replace('<body>', `<body><script>${readFileSync('e2e/mock-claude.js', 'utf8')}</script>`);
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(page);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/db/')) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const { path, body } = JSON.parse(raw || '{}');
        const op = url.pathname.slice(4);
        let out = {};
        if (op === 'get') out = { body: docs.get(path) || null };
        else if (op === 'set') docs.set(path, body);
        else if (op === 'delete') docs.delete(path);
        else if (op === 'list') {
          const depth = path.split('/').length + 1;
          out = { docs: [...docs].filter(([p]) => p.startsWith(path + '/') && p.split('/').length === depth).map(([p, b]) => ({ path: p, body: b })) };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (req.method === 'GET') {
      const rel = normalize(url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join('site', rel);
      if (existsSync(file)) {
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        return res.end(readFileSync(file));
      }
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, docs })));
}
