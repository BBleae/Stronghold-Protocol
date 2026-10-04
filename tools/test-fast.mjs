#!/usr/bin/env node
// tools/test-fast.mjs — the whole suite with fewer full-match soak seeds (≈1–2 min instead of ≈3), for iterating.
//
//   npm run test:fast                       # every test file, MATCH_SEEDS=3
//   npm run test:fast -- test/worker        # any extra args go straight to `node --test`
//   MATCH_SEEDS=5 npm run test:fast         # an explicit MATCH_SEEDS wins
//
// Not a release gate: run the full `npm test` (MATCH_SEEDS=20) once before committing or deploying.

import { spawnSync } from 'node:child_process';

const env = { ...process.env, MATCH_SEEDS: process.env.MATCH_SEEDS || '3' };
const { status, error } = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', env });
if (error) throw error;
process.exit(status ?? 1);
