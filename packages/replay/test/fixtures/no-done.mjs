// Lifecycle fixture — announces ready on IPC but never sends recurr:done.
// The injected request is answered (so injection succeeds) but the child
// then lingers forever — exercises the replay-deadline TIMEOUT path.
import http from 'node:http';

const s = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{"ok":true}');
});
s.listen(0, '127.0.0.1', () => {
  process.send?.({ type: 'recurr:ready', port: s.address().port });
});
