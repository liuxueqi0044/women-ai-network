import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPOSE_FILE = path.join(ROOT, 'deploy', 'compose.staging.yaml');
export const DEFAULT_ENV_FILE = path.join(ROOT, 'deploy', 'staging.env');
export const BACKUP_DIR = path.join(ROOT, 'backups');

export function parseEnv(text) {
  const result = {};
  for (const [index, rawLine] of text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/u)
    .entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`invalid env entry on line ${index + 1}`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      throw new Error(`invalid env key on line ${index + 1}`);
    }
    if (Object.hasOwn(result, key)) throw new Error(`duplicate env key: ${key}`);
    result[key] = line.slice(separator + 1).trim();
  }
  return result;
}

export async function loadEnvFile(file = DEFAULT_ENV_FILE) {
  return parseEnv(await readFile(file, 'utf8'));
}

function requireValue(env, key) {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  if (/REPLACE_|SECRET_MANAGER|example\.com/iu.test(value)) {
    throw new Error(`${key} still contains a placeholder`);
  }
  return value;
}

function exactBase64Key(value, key) {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) throw new Error(`${key} must be a base64 32-byte key`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
    throw new Error(`${key} must be a base64 32-byte key`);
  }
}

function strictBoolean(env, key) {
  const value = requireValue(env, key);
  if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`);
  return value === 'true';
}

function origin(value, key, pathName = '') {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${key} must use HTTP(S)`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${key} must not contain credentials, query or fragment`);
  }
  if (parsed.pathname.replace(/\/$/u, '') !== pathName) {
    throw new Error(`${key} must end with ${pathName || 'a bare origin'}`);
  }
  return parsed;
}

export function validateStagingEnv(env) {
  if (requireValue(env, 'NODE_ENV') !== 'production')
    throw new Error('NODE_ENV must be production');
  if (strictBoolean(env, 'LOG_PRETTY')) throw new Error('LOG_PRETTY must be false');
  if (!strictBoolean(env, 'IAM_COOKIE_SECURE')) throw new Error('IAM_COOKIE_SECURE must be true');
  if (strictBoolean(env, 'ENABLE_OPENAPI')) throw new Error('ENABLE_OPENAPI must be false');

  const project = requireValue(env, 'COMPOSE_PROJECT_NAME');
  if (!/^[a-z0-9][a-z0-9_-]{2,48}$/u.test(project)) {
    throw new Error('COMPOSE_PROJECT_NAME must be a scoped lowercase Compose name');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,127}$/u.test(requireValue(env, 'WAI_IMAGE_REPOSITORY'))) {
    throw new Error('WAI_IMAGE_REPOSITORY is not a safe image repository');
  }
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{1,127}$/u.test(requireValue(env, 'WAI_IMAGE_TAG'))) {
    throw new Error('WAI_IMAGE_TAG is not a safe image tag');
  }
  for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'VALKEY_PASSWORD']) {
    const value = requireValue(env, key);
    if (key.endsWith('PASSWORD') && value.length < 24) throw new Error(`${key} is too short`);
    if (/[:@/\s]/u.test(value)) throw new Error(`${key} contains a URL-unsafe character`);
  }
  for (const key of ['STAGING_WEB_PORT', 'STAGING_API_PORT']) {
    const value = Number(requireValue(env, key));
    if (!Number.isInteger(value) || value < 1024 || value > 65535)
      throw new Error(`${key} is invalid`);
  }
  if (env.STAGING_WEB_PORT === env.STAGING_API_PORT) throw new Error('staging ports must differ');

  const api = origin(requireValue(env, 'API_BASE_URL'), 'API_BASE_URL');
  const publicApi = origin(
    requireValue(env, 'NEXT_PUBLIC_API_BASE_URL'),
    'NEXT_PUBLIC_API_BASE_URL',
    '/v1',
  );
  if (publicApi.origin !== api.origin) throw new Error('public and server API origins must match');
  const cors = requireValue(env, 'CORS_ORIGINS')
    .split(',')
    .map((value) => value.trim());
  if (cors.includes('*')) throw new Error('CORS_ORIGINS must not contain a wildcard');
  for (const value of cors) origin(value, 'CORS_ORIGINS');

  if (requireValue(env, 'IAM_SECRET_PEPPER').length < 32)
    throw new Error('IAM_SECRET_PEPPER is too short');
  const keyId = requireValue(env, 'IAM_PII_KEY_ID');
  let piiKeys;
  try {
    piiKeys = JSON.parse(requireValue(env, 'IAM_PII_KEYS'));
  } catch {
    throw new Error('IAM_PII_KEYS must be valid JSON');
  }
  if (typeof piiKeys !== 'object' || piiKeys === null || Array.isArray(piiKeys)) {
    throw new Error('IAM_PII_KEYS must be a key map');
  }
  exactBase64Key(piiKeys[keyId] ?? '', `IAM_PII_KEYS.${keyId}`);
  exactBase64Key(requireValue(env, 'SAFETY_VAULT_KEY'), 'SAFETY_VAULT_KEY');
  exactBase64Key(requireValue(env, 'STAGING_BACKUP_KEY'), 'STAGING_BACKUP_KEY');

  const mediaEnabled = strictBoolean(env, 'MEDIA_UPLOADS_ENABLED');
  for (const key of ['MEDIA_STORAGE_ADAPTER', 'MEDIA_SCANNER_ADAPTER', 'MEDIA_SANITIZER_ADAPTER']) {
    if (requireValue(env, key) !== 'real') throw new Error(`${key} must remain real in production`);
  }
  if (requireValue(env, 'MEDIA_CONTENT_MODERATION_ADAPTER') !== 'doubao') {
    throw new Error('MEDIA_CONTENT_MODERATION_ADAPTER must remain doubao in production');
  }
  if (mediaEnabled) {
    const endpoint = origin(requireValue(env, 'MEDIA_S3_ENDPOINT'), 'MEDIA_S3_ENDPOINT');
    if (endpoint.protocol !== 'https:') throw new Error('MEDIA_S3_ENDPOINT must use HTTPS');
    const ark = origin(requireValue(env, 'ARK_API_BASE_URL'), 'ARK_API_BASE_URL', '/api/v3');
    if (ark.protocol !== 'https:') throw new Error('ARK_API_BASE_URL must use HTTPS');
    for (const key of [
      'MEDIA_S3_QUARANTINE_BUCKET',
      'MEDIA_S3_CLEAN_BUCKET',
      'MEDIA_S3_QUARANTINE_ACCESS_KEY',
      'MEDIA_S3_QUARANTINE_SECRET_KEY',
      'MEDIA_S3_CLEAN_ACCESS_KEY',
      'MEDIA_S3_CLEAN_SECRET_KEY',
      'CLAMAV_HOST',
      'ARK_API_KEY',
      'ARK_VISION_MODEL',
    ])
      requireValue(env, key);
  }
  return { project, mediaEnabled, apiUrl: api.origin, webUrl: cors[0] };
}

export function cliOption(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return found === undefined ? fallback : found.slice(prefix.length);
}

export function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

export function composeArgs(envFile, project, rest = []) {
  return ['compose', '--env-file', envFile, '-f', COMPOSE_FILE, '-p', project, ...rest];
}

export async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...options.env },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} exited with ${code ?? `signal ${signal ?? 'unknown'}`}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`,
          ),
        );
    });
  });
}

export function randomBase64Key() {
  return randomBytes(32).toString('base64');
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  const input = createReadStream(file);
  input.on('data', (chunk) => hash.update(chunk));
  await finished(input);
  return hash.digest('hex');
}

export async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
