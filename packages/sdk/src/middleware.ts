import type { NextFunction, Request, Response } from 'express';
import { als, pushEvent, type RuntimeCtx } from './context.js';

/** Normalize IPv4-mapped IPv6 addresses so capture/replay agree. */
function normalizeAddr(addr: string | undefined): string | undefined {
  return addr?.replace(/^::ffff:/, '');
}

export const CTX_KEY = Symbol.for('recurr.ctx');
import { buildRecord, extractRequest, makeCtx, persist, recordError, shouldPersist, type RecurrState, type RequestLike } from './state.js';

/**
 * Express/connect-compatible middleware. Opens a capture (or replay) context
 * per request, records the inbound event, tees the response body, and
 * persists the ExecutionRecord on finish when the capture policy says so.
 */
export function createMiddleware(state: RecurrState) {
  return function recurrMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (state.mode === 'off') {
      next();
      return;
    }
    // Mounted twice (app.use + router.use, or duplicate calls)? One ctx wins —
    // a second record for the same request would be noise, not signal.
    if ((req as unknown as Record<symbol, unknown>)[CTX_KEY]) {
      next();
      return;
    }
    const ctx = makeCtx(state);
    (req as unknown as Record<symbol, unknown>)[CTX_KEY] = ctx;
    als.run(ctx, () => {
      const url = req.originalUrl ?? req.url ?? '/';
      pushEvent(ctx, 'http.in', {
        name: `${req.method} ${url.split('?')[0]}`,
        data: {
          method: req.method,
          url: ctx.redactor.redactUrl(url).value,
          remoteAddr: normalizeAddr(req.socket?.remoteAddress),
          userAgent: req.headers['user-agent'],
        },
      });

      // Tee response body.
      const chunks: Buffer[] = [];
      let bytes = 0;
      const cap = ctx.redactor.maxBodyBytes;
      const collect = (chunk: unknown) => {
        if (chunk === undefined || bytes >= cap) return;
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        chunks.push(b.subarray(0, Math.max(0, cap - bytes)));
        bytes += b.length;
      };
      const origWrite = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => unknown;
      const origEnd = res.end.bind(res) as (chunk?: unknown, ...rest: unknown[]) => unknown;
      res.write = ((chunk: unknown, ...rest: unknown[]) => {
        collect(chunk);
        return origWrite(chunk, ...rest);
      }) as typeof res.write;
      res.end = ((chunk?: unknown, ...rest: unknown[]) => {
        if (typeof chunk !== 'function') collect(chunk);
        return origEnd(chunk, ...rest);
      }) as typeof res.end;

      const innerNext = (err?: unknown) => {
        if (err) recordError(ctx, err);
        next(err as never);
      };

      let repersistTimer: NodeJS.Timeout | undefined;
      let repersistCount = 0;
      const finalize = (aborted: boolean) => {
        if (ctx.closed) return;
        ctx.aborted = aborted || undefined;
        if (aborted) {
          pushEvent(ctx, 'log', { name: 'response.aborted', status: 'error', data: { message: 'connection closed before response finished' } });
        }
        const ct = String(res.getHeader('content-type') ?? '');
        const ce = String(res.getHeader('content-encoding') ?? '');
        const encoded = ce !== '' && ce !== 'identity';
        const isTextual = !encoded && (!ct || /json|text|xml|urlencoded|javascript|html/.test(ct));
        const rawBody = chunks.length ? Buffer.concat(chunks) : undefined;
        const bodyStr = rawBody === undefined ? undefined : isTextual ? rawBody.toString('utf8') : rawBody.toString('base64');
        const bodyB64 = rawBody !== undefined && !isTextual;

        // Async captures (cloned fetch bodies) must land before we serialize.
        void Promise.allSettled([...ctx.pending]).then(() => {
          const record = buildRecord(ctx, state, req as RequestLike, res, bodyStr, bodyB64);
          const saved = shouldPersist(ctx, state, res.statusCode) || aborted;
          if (saved) persist(ctx, state, record);
          ctx.closed = true;
          // Fire-and-forget work may still push events after finish — re-save
          // (bounded) so the timeline stays honest instead of dropping them.
          if (saved) {
            ctx.repersist = () => {
              if (repersistCount >= 20 || repersistTimer) return;
              repersistTimer = setTimeout(() => {
                repersistTimer = undefined;
                repersistCount++;
                persist(ctx, state, buildRecord(ctx, state, req as RequestLike, res, bodyStr, bodyB64));
              }, 25);
              repersistTimer.unref?.();
            };
          }
        });
      };

      res.on('finish', () => finalize(false));
      // 'close' without 'finish' = client disconnected mid-flight; still capture
      // the partial record — an aborted request is an incident worth seeing.
      res.on('close', () => {
        if (!ctx.closed && !res.writableFinished) finalize(true);
      });

      innerNext();
    });
  };
}

/**
 * Express error-handling middleware — mount BEFORE the app's own error
 * handler so the error (name/message/stack) lands in the record.
 *
 *   app.use(recurr.errorMiddleware());
 *   app.use((err, req, res, next) => { ... });
 */
export function createErrorMiddleware(state: RecurrState) {
  return function recurrErrorMiddleware(err: unknown, req: Request, _res: Response, next: NextFunction): void {
    const ctx = als.getStore() ?? (req as unknown as Record<symbol, RuntimeCtx | undefined>)[CTX_KEY];
    if (ctx) recordError(ctx, err);
    next(err);
  };
}
