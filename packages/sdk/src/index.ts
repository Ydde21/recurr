// doctor.js MUST evaluate first — its module-eval baseline records which
// sandbox-blocked builtins the host loaded before our own patches did.
import './doctor.js';

export { init, type Recurr } from './init.js';
export { type RecurrConfig, type CaptureOptions } from './config.js';
export { type DoctorReport, type DoctorFinding } from './doctor.js';
export { instrumentDb, type Queryable } from './patches/db.js';
export { currentCtx } from './context.js';
export { RecurrIsolationError } from './patches/isolation.js';
export { openStore, FileStore, PgStore, type IncidentStore } from '@recurr-dev/store';
export type { ExecutionRecord, TimelineEvent } from '@recurr-dev/core';
