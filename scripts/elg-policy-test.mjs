#!/usr/bin/env node
/**
 * ELG-01 policy test runner (pnpm test:elg:policy).
 *
 * Runs the Rego test matrix inside the SAME pinned OPA image the API talks to
 * (openpolicyagent/opa:1.17.0-static — never `latest`), enforcing:
 *   - all Rego tests pass (opa test --fail-on-empty exits non-zero otherwise)
 *   - statement coverage >= COVERAGE_THRESHOLD (percent, default 97)
 *
 * The policies directory is bind-mounted read-only; the container writes
 * nothing. On Windows/Git-Bash MSYS_NO_PATHCONV keeps the native C:\... mount
 * path intact. Two runs because OPA 1.x drops per-test results when
 * --coverage is combined with --format=json.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OPA_IMAGE = 'openpolicyagent/opa:1.17.0-static';
const COVERAGE_THRESHOLD = 97;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const policiesDir = path.resolve(scriptDir, '../packages/authz/policies');
const containerDir = '/policy';

function dockerEnv() {
  const env = { ...process.env };
  if (process.platform === 'win32') {
    env['MSYS_NO_PATHCONV'] = '1';
  }
  return env;
}

function dockerRun(opaArgs) {
  const args = ['run', '--rm', '-v', `${policiesDir}:${containerDir}:ro`, OPA_IMAGE, ...opaArgs];
  return execFileSync('docker', args, { env: dockerEnv(), encoding: 'utf8' });
}

/** Run 1: per-test JSON results (failures carry `fail: true`). */
function runTests() {
  const stdout = dockerRun(['test', '--format=json', '--fail-on-empty', containerDir]);
  return JSON.parse(stdout);
}

/** Run 2: statement coverage (0-100). */
function runCoverage() {
  const stdout = dockerRun(['test', '--format=json', '--coverage', containerDir]);
  return JSON.parse(stdout);
}

function main() {
  const results = runTests();
  const failed = results.filter((entry) => entry.fail === true);
  const passed = results.length - failed.length;

  const coverageReport = runCoverage();
  const coverage = coverageReport.coverage;

  console.log(`policy tests: ${passed} passed, ${failed.length} failed`);
  console.log(`statement coverage: ${coverage.toFixed(2)}% (threshold ${COVERAGE_THRESHOLD}%)`);

  if (failed.length > 0) {
    for (const failure of failed) {
      console.error(
        `\nFAIL ${failure.package}: ${failure.name} — ${failure.location?.file}:${failure.location?.row}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  if (typeof coverage !== 'number' || coverage < COVERAGE_THRESHOLD) {
    console.error(
      `coverage ${typeof coverage === 'number' ? coverage.toFixed(2) : String(coverage)}% below threshold ${COVERAGE_THRESHOLD}%`,
    );
    process.exitCode = 1;
  }
}

main();
