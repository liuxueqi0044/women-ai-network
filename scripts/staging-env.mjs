import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_ENV_FILE,
  ROOT,
  cliOption,
  hasFlag,
  loadEnvFile,
  randomBase64Key,
  validateStagingEnv,
} from './staging-lib.mjs';

const command = process.argv[2] ?? 'generate';
const envFile = path.resolve(ROOT, cliOption('env-file', path.relative(ROOT, DEFAULT_ENV_FILE)));

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function generate() {
  if ((await exists(envFile)) && !hasFlag('force')) {
    throw new Error(
      `${path.relative(ROOT, envFile)} already exists; pass --force only to rotate every staging secret`,
    );
  }
  const template = await readFile(path.join(ROOT, 'deploy', 'staging.env.template'), 'utf8');
  const pii = randomBase64Key();
  const generated = template
    .replace(
      'WAI_IMAGE_TAG=REPLACE_WITH_IMMUTABLE_IMAGE_TAG',
      `WAI_IMAGE_TAG=local-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}`,
    )
    .replace('REPLACE_WITH_RANDOM_DATABASE_PASSWORD', randomBytes(32).toString('base64url'))
    .replace('REPLACE_WITH_RANDOM_VALKEY_PASSWORD', randomBytes(32).toString('base64url'))
    .replace('REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARS', randomBytes(48).toString('base64url'))
    .replace('REPLACE_WITH_BASE64_32_BYTE_AES_KEY', pii)
    .replace('REPLACE_WITH_BASE64_32_BYTE_AES_KEY', randomBase64Key())
    .replace('REPLACE_WITH_BASE64_32_BYTE_BACKUP_KEY', randomBase64Key());
  await writeFile(envFile, generated, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  validateStagingEnv(await loadEnvFile(envFile));
  console.log(
    `generated and validated ${path.relative(ROOT, envFile)} (secret values not displayed)`,
  );
}

async function preflight() {
  const summary = validateStagingEnv(await loadEnvFile(envFile));
  console.log(
    `staging preflight passed: project=${summary.project}, media=${summary.mediaEnabled ? 'enabled' : 'disabled-fail-closed'}`,
  );
}

try {
  if (command === 'generate') await generate();
  else if (command === 'preflight') await preflight();
  else throw new Error('usage: staging-env.mjs generate|preflight [--env-file=path] [--force]');
} catch (error) {
  console.error(`[staging-env] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
