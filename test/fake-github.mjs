// A small in-memory stand-in for the parts of the GitHub REST API the app
// uses: repository info and the contents API with sha-based concurrency.

export function createFakeGitHub({ token = 'good-token', repo = 'me/pocket-data', isPrivate = true } = {}) {
  const files = new Map(); // path -> { sha, content(base64) }
  let n = 0;
  const log = [];

  function respond(status, body, headers = {}) {
    return { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag', ...headers }, body: body == null ? '' : JSON.stringify(body) };
  }

  function handle(method, url, headers, rawBody) {
    const u = new URL(url);
    log.push({ method, path: u.pathname, body: rawBody });
    if (method === 'OPTIONS') return respond(204, null, { 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT' });
    const auth = headers.authorization || headers.Authorization;
    if (auth !== `Bearer ${token}`) return respond(401, { message: 'Bad credentials' });
    const prefix = `/repos/${repo}`;
    if (!u.pathname.startsWith(prefix)) return respond(404, { message: 'Not Found' });
    const rest = u.pathname.slice(prefix.length);
    if (rest === '' && method === 'GET') return respond(200, { full_name: repo, private: isPrivate });
    if (!rest.startsWith('/contents/')) return respond(404, { message: 'Not Found' });
    const path = decodeURIComponent(rest.slice('/contents/'.length));
    if (method === 'GET') {
      if (files.has(path)) {
        const f = files.get(path);
        return respond(200, { name: path.split('/').pop(), path, sha: f.sha, content: f.content.replace(/(.{60})/g, '$1\n'), encoding: 'base64' });
      }
      const children = [...files.entries()].filter(([p]) => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/'));
      if (!children.length) return respond(404, { message: 'Not Found' });
      const list = children.map(([p, f]) => ({ name: p.split('/').pop(), path: p, sha: f.sha, type: 'file' })).sort((a, b) => a.name.localeCompare(b.name));
      const etag = '"' + list.map((x) => x.sha).join('.') + '"';
      const inm = headers['if-none-match'] || headers['If-None-Match'];
      if (inm === etag) return respond(304, null, { etag });
      return respond(200, list, { etag });
    }
    if (method === 'PUT') {
      const body = JSON.parse(rawBody);
      const cur = files.get(path);
      if (cur && !body.sha) return respond(422, { message: '"sha" wasn\'t supplied.' });
      if (cur && body.sha !== cur.sha) return respond(409, { message: 'does not match' });
      if (!cur && body.sha) return respond(409, { message: 'does not match' });
      const sha = 'sha' + ++n;
      files.set(path, { sha, content: body.content });
      return respond(cur ? 200 : 201, { content: { sha, path } });
    }
    return respond(405, { message: 'no' });
  }

  // fetch() compatible wrapper for Node tests, with optional per-client offline flag.
  function fetchFor(client = {}) {
    return async (url, opts = {}) => {
      await new Promise((r) => setTimeout(r, Math.random() * 6));
      if (client.offline) throw new TypeError('Failed to fetch');
      const h = {};
      for (const [k, v] of Object.entries(opts.headers || {})) h[k.toLowerCase()] = v;
      const r = handle(opts.method || 'GET', url, h, opts.body);
      return {
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        headers: { get: (k) => r.headers[k.toLowerCase()] || null },
        json: async () => JSON.parse(r.body),
      };
    };
  }

  return { handle, fetchFor, files, log, repo, token };
}
