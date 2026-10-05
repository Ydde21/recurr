/** Event-kind → fill color used by timeline + graph (CSS var names). */
export const KIND_FILL: Record<string, string> = {
  'http.in': 'var(--accent)',
  'db.query': 'var(--teal)',
  'http.out': 'var(--purple)',
  error: 'var(--err)',
  retry: 'var(--warn)',
  log: 'var(--text-faint)',
  custom: 'var(--cyan)',
  'replay.note': '#8a63d2',
};
