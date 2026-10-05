import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { diffExecutions } from '@recurr/core/diff';
import { api } from '../api';
import { useApi } from '../hooks';
import { ErrorState, Loading, Empty } from '../components/states';
import { DiffView } from '../components/DiffView';

/* Original vs Replay — runs the same diff engine the CLI uses, in-browser. */

export function DiffPage() {
  const { id, rid } = useParams<{ id: string; rid: string }>();
  const orig = useApi(() => api.getRecord(id!), [id]);
  const repl = useApi(() => api.getRecord(rid!), [rid]);

  const report = useMemo(() => {
    if (!orig.data || !repl.data) return undefined;
    return diffExecutions(orig.data, repl.data);
  }, [orig.data, repl.data]);

  const loading = orig.loading || repl.loading;
  const error = orig.error ?? repl.error;

  return (
    <div className="page">
      {loading ? (
        <Loading label={`diffing ${id} vs ${rid}`} />
      ) : error ? (
        <ErrorState error={error} onRetry={orig.error ? orig.refetch : repl.refetch} />
      ) : !orig.data || !repl.data || !report ? (
        <Empty title="record not found" />
      ) : (
        <>
          {orig.data.kind === 'replay' && (
            <div className="banner warn">
              {orig.data.id} is a replay record — arguments may be swapped.{' '}
              {orig.data.replayOf && (
                <Link to={`/incidents/${orig.data.replayOf}/diff/${orig.data.id}`}>diff it against its incident instead</Link>
              )}
            </div>
          )}
          <DiffView original={orig.data} replay={repl.data} report={report} />
        </>
      )}
    </div>
  );
}
