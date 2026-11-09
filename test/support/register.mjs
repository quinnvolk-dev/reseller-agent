// Loaded with `node --import` by `npm test`. If the real better-sqlite3 works on this machine,
// tests use it. If its native module was never built, route the import to the node:sqlite shim.
import { register } from 'node:module';

let realWorks = false;
try {
  const { default: Database } = await import('better-sqlite3');
  new Database(':memory:').close();
  realWorks = true;
} catch {
  realWorks = false;
}

if (!realWorks) {
  const shimUrl = new URL('./sqlite-shim.js', import.meta.url).href;
  const hooks = `
    export async function resolve(specifier, context, next) {
      if (specifier === 'better-sqlite3') return { url: ${JSON.stringify(shimUrl)}, shortCircuit: true };
      return next(specifier, context);
    }`;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
  process.stderr.write('[test] better-sqlite3 native module unavailable; using node:sqlite shim\n');
}
