// ESM escape fixture — a STATIC named import of node:child_process. ESM
// namespace bindings snapshot at module-load time, so export-patching alone
// cannot intercept this. The replay preload (NODE_OPTIONS --import) blocks
// the module load entirely → this app must fail to START during replay while
// working normally during capture.
import { execSync } from 'node:child_process';
import http from 'node:http';
import { init } from '@recurr-dev/sdk';

// Touch the binding so the import can't be tree-shaken away.
const marker = typeof execSync === 'function' ? 'loaded' : 'missing';

const recurr = await init({ service: 'esm-escape', capture: { on: 'always' } });
const mw = recurr.middleware();

http
  .createServer((req, res) => {
    mw(req, res, () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ marker }));
    });
  })
  .listen(Number(process.env.PORT ?? 0), '127.0.0.1');
