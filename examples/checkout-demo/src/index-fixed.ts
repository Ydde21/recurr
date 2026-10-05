import { buildApp } from './app.js';

// "Fixed" variant — used to verify that a code change resolves the captured
// incident. `recurr replay -t "node dist/index-fixed.js"` replays the same
// recorded inputs; the payment still times out, but the order is now accepted
// as pending_payment (202) instead of crashing (500).

const port = Number(process.env.PORT ?? 4790);

const { app, recurr } = await buildApp({ resilient: true });

const server = app.listen(port, () => {
  const addr = server.address();
  console.log(`[checkout-api/fixed] listening on ${typeof addr === 'object' && addr ? addr.port : port}${recurr.isReplay() ? ' (replay mode)' : ''}`);
});
