#!/usr/bin/env node
import { start } from './index.js';

void start().catch((err) => {
  console.error('[recurr-server] fatal:', err);
  process.exit(1);
});
