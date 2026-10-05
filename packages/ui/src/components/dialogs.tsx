import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';

/* Modal dialogs — replay target picker, scenario naming, run launcher. */

let dialogSeq = 0;

export function Dialog({ title, children, footer, onClose }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [id] = useState(() => `dlg-${++dialogSeq}`);
  const restoreRef = useRef<Element | null>(null);
  useEffect(() => {
    // Capture the restore target once — the effect re-runs when onClose's
    // identity changes (e.g. busy toggle), and activeElement by then may be
    // inside the dialog itself.
    if (!restoreRef.current) restoreRef.current = document.activeElement;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && ref.current) {
        // Focus trap — keep Tab/Shift+Tab cycling inside the dialog.
        const focusable = ref.current.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
        );
        const list = [...focusable].filter((el) => !el.hasAttribute('disabled'));
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !ref.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    ref.current?.querySelector('input')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      (restoreRef.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`}>
        <div className="dialog-h" id={`${id}-t`}>{title}</div>
        <div className="dialog-b">{children}</div>
        {footer && <div className="dialog-f">{footer}</div>}
      </div>
    </div>
  );
}

export interface ReplayTargetForm {
  command: string;
  cwd: string;
  timeoutMs: string;
}

/** Shared target form — command + cwd + timeout. The replay engine sanitizes
 *  env; the UI does not offer env overrides (keeps the sandbox obvious). */
export function TargetFields({ form, setForm }: { form: ReplayTargetForm; setForm: (f: ReplayTargetForm) => void }) {
  return (
    <>
      <div className="field">
        <label htmlFor="t-cmd">target command</label>
        <input
          id="t-cmd"
          type="text"
          className="mono"
          placeholder='node dist/index.js'
          value={form.command}
          onChange={(e) => setForm({ ...form, command: e.target.value })}
        />
        <div className="hint">
          Runs the instrumented app inside an isolated replay process — network egress, subprocesses, workers and
          native addons are blocked; the store endpoint is the only allowlisted target.
        </div>
      </div>
      <div className="field">
        <label htmlFor="t-cwd">working directory (optional)</label>
        <input id="t-cwd" type="text" className="mono" placeholder="/path/to/app" value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="t-timeout">timeout (ms)</label>
        <input id="t-timeout" type="number" min={1000} max={300000} value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: e.target.value })} />
      </div>
    </>
  );
}

export function ReplayDialog({
  incidentId,
  onRun,
  onClose,
}: {
  incidentId: string;
  onRun: (form: ReplayTargetForm) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ReplayTargetForm>({ command: 'node dist/index.js', cwd: '', timeoutMs: '60000' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const run = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await onRun(form);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={
        <>
          replay <span className="mono">{incidentId}</span>
        </>
      }
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          {err && <span className="mono" style={{ color: 'var(--err)', fontSize: 11, marginRight: 'auto', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>{err}</span>}
          <button className="btn" onClick={onClose} disabled={busy}>
            cancel
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={busy || !form.command.trim()}>
            {busy ? 'replaying…' : 'start replay'}
          </button>
        </>
      }
    >
      <TargetFields form={form} setForm={setForm} />
      {busy && (
        <div className="hint">
          reconstructing the environment, injecting the recorded request, and diffing — this can take up to a minute
          while the isolated target runs.
        </div>
      )}
    </Dialog>
  );
}
