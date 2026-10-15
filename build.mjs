// Builds a single self-contained page from the ES modules in src/.
// No dependencies: modules are concatenated in dependency order with their
// import/export syntax removed, inside one strict-mode function scope.
//
//   site/ and repo root    the installable web app (index.html, service
//                          worker, manifest, icons); Pages serves the root
//   dist/pocket-time.html  page body for publishing as a Claude Artifact
//   dist/standalone.html   the same page as a plain HTML document (tests)

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ORDER = ['digits', 'dates', 'parse', 'crdt', 'crypto', 'storage', 'sync', 'remote', 'i18n', 'app'];

const seen = new Map();
const parts = ORDER.map((name) => {
  let code = readFileSync(`src/${name}.js`, 'utf8');
  code = code.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*\n/gm, '');
  code = code.replace(/^export (?=(async )?function|const|let|class)/gm, '');
  if (/^\s*(import|export)\s/m.test(code)) throw new Error(`Unhandled import/export left in ${name}.js`);
  for (const m of code.matchAll(/^(?:async )?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (seen.has(m[1])) throw new Error(`Top-level name "${m[1]}" defined in both ${seen.get(m[1])}.js and ${name}.js`);
    seen.set(m[1], name);
  }
  return `// ---- ${name}.js ----\n${code}`;
});

const script = `(function () {\n'use strict';\n${parts.join('\n')}\n})();`;
if (script.includes('</script')) throw new Error('Script contains a closing script tag');

const styles = readFileSync('src/styles.css', 'utf8');
const page = readFileSync('src/index.html', 'utf8').replace('/*STYLES*/', () => styles).replace('/*SCRIPT*/', () => script);

const BASE_HEAD =
  '<meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">' +
  '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}[hidden]{display:none!important}</style>';

// The site may only talk to itself and the GitHub API: no third parties.
const SITE_HEAD =
  BASE_HEAD +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.github.com; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'">` +
  '<meta name="referrer" content="no-referrer">' +
  '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">' +
  '<meta name="theme-color" content="#16191e" media="(prefers-color-scheme: dark)">' +
  '<meta name="apple-mobile-web-app-capable" content="yes">' +
  '<meta name="mobile-web-app-capable" content="yes">' +
  '<meta name="apple-mobile-web-app-title" content="Pocket Time">' +
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">' +
  '<link rel="manifest" href="manifest.webmanifest">' +
  '<link rel="apple-touch-icon" href="apple-touch-icon.png">' +
  '<link rel="icon" href="icon-192.png">';

const doc = (head) => `<!doctype html><html lang="ar" dir="rtl"><head>${head}</head><body>${page}</body></html>`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/pocket-time.html', page);
writeFileSync('dist/standalone.html', doc(BASE_HEAD));

const index = doc(SITE_HEAD);
const version = createHash('sha256').update(index).digest('hex').slice(0, 12);
const icons = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
const manifest = {
  name: 'Pocket Time',
  short_name: 'Pocket Time',
  description: 'مذكرة جيب خاصة لتنظيم اليوم',
  lang: 'ar',
  dir: 'rtl',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#ffffff',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
const sw = readFileSync('src/sw.js', 'utf8')
  .replace('__VERSION__', version)
  .replace('__FILES__', JSON.stringify(['./', 'index.html', 'manifest.webmanifest', ...icons]));

mkdirSync('site', { recursive: true });
writeFileSync('site/index.html', index);
writeFileSync('site/404.html', index);
writeFileSync('site/manifest.webmanifest', JSON.stringify(manifest, null, 2));
writeFileSync('site/sw.js', sw);
writeFileSync('site/.nojekyll', '');
for (const f of icons) copyFileSync(`assets/${f}`, `site/${f}`);

// GitHub Pages serves the repository root of main: publish the app there.
for (const f of ['index.html', '404.html', 'manifest.webmanifest', 'sw.js', '.nojekyll', ...icons]) copyFileSync(`site/${f}`, f);
console.log(`site/index.html  ${(index.length / 1024).toFixed(1)} KB  (version ${version})`);
