import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 4790);

const { app, recurr } = await buildApp({ resilient: false });

const server = app.listen(port, () => {
  const addr = server.address();
  console.log(`[checkout-api] listening on ${typeof addr === 'object' && addr ? addr.port : port}${recurr.isReplay() ? ' (replay mode)' : ''}`);
});
