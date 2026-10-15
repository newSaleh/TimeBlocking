// Serves the built page with the runtime test double, plus a tiny JSON
// document store standing in for the artifact database.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

export function startServer(port = 4173) {
  const docs = new Map();
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
      const page = readFileSync('dist/standalone.html', 'utf8').replace(
        '<body>',
        `<body><script>${readFileSync('e2e/mock-claude.js', 'utf8')}</script>`,
      );
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/db/')) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const { path, body } = JSON.parse(raw || '{}');
        const op = url.pathname.slice(4);
        log.push({ op, path, body });
        let out = {};
        if (op === 'get') out = { body: docs.get(path) || null };
        else if (op === 'set') docs.set(path, body);
        else if (op === 'update') docs.set(path, { ...(docs.get(path) || {}), ...body });
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
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, docs, log })));
}
