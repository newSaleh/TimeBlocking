// Builds a single self-contained page from the ES modules in src/.
// No dependencies: modules are concatenated in dependency order with their
// import/export syntax removed, inside one strict-mode function scope.
//
//   dist/pocket-time.html  page body for publishing as a Claude Artifact
//   dist/standalone.html   the same page as a complete HTML document

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

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

const standalone =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}[hidden]{display:none!important}</style>' +
  '</head><body>' +
  page +
  '</body></html>';

mkdirSync('dist', { recursive: true });
writeFileSync('dist/pocket-time.html', page);
writeFileSync('dist/standalone.html', standalone);
console.log(`dist/pocket-time.html  ${(page.length / 1024).toFixed(1)} KB`);
