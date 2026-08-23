import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  BACKUP_DIR,
  DEFAULT_ENV_FILE,
  ROOT,
  cliOption,
  composeArgs,
  loadEnvFile,
  run,
  sha256File,
  validateStagingEnv,
  writeJson,
} from './staging-lib.mjs';

const MAGIC = Buffer.from('WAIBACKUP1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const command = process.argv[2];
const envFile = path.resolve(ROOT, cliOption('env-file', path.relative(ROOT, DEFAULT_ENV_FILE)));
process.env['STAGING_RUNTIME_ENV_FILE'] = envFile;

function withinBackups(file) {
  const resolved = path.resolve(file);
  const relative = path.relative(BACKUP_DIR, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('backup paths must stay inside the workspace backups directory');
  }
  return resolved;
}

async function waitForChild(child, label) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${code ?? `signal ${signal ?? 'unknown'}`}`));
    });
  });
}

async function ensureProject(env, project) {
  const args = composeArgs(envFile, project, ['ps', '-q', 'postgres']);
  const { stdout } = await run('docker', args, { capture: true });
  const container = stdout.trim();
  if (!container) throw new Error(`PostgreSQL is not running for Compose project ${project}`);
  const inspected = await run(
    'docker',
    ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', container],
    { capture: true },
  );
  if (inspected.stdout.trim() !== project)
    throw new Error('resolved container project label mismatch');
  return container;
}

async function dumpDatabase(env, project, output) {
  const temporary = `${output}.plain.tmp`;
  const args = composeArgs(envFile, project, [
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    '-U',
    env.POSTGRES_USER,
    '-d',
    env.POSTGRES_DB,
    '--format=custom',
    '--compress=6',
    '--no-owner',
    '--no-acl',
  ]);
  const child = spawn('docker', args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false,
  });
  try {
    await Promise.all([
      pipeline(child.stdout, createWriteStream(temporary, { mode: 0o600 })),
      waitForChild(child, 'pg_dump'),
    ]);
    return temporary;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function encryptDump(plain, output, rawKey) {
  const key = Buffer.from(rawKey, 'base64');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  await writeFile(output, Buffer.concat([MAGIC, iv]), { mode: 0o600 });
  await pipeline(
    createReadStream(plain),
    cipher,
    createWriteStream(output, { mode: 0o600, flags: 'a' }),
  );
  await appendFile(output, cipher.getAuthTag());
}

async function decryptDump(input, plain, rawKey) {
  const info = await stat(input);
  const minimum = MAGIC.byteLength + IV_BYTES + TAG_BYTES + 1;
  if (info.size < minimum) throw new Error('backup is truncated');
  const handle = await open(input, 'r');
  try {
    const header = Buffer.alloc(MAGIC.byteLength + IV_BYTES);
    await handle.read(header, 0, header.byteLength, 0);
    if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC))
      throw new Error('backup format is invalid');
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(rawKey, 'base64'),
      header.subarray(MAGIC.byteLength),
    );
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(input, { start: header.byteLength, end: info.size - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(plain, { mode: 0o600, flags: 'w' }),
    );
  } finally {
    await handle.close();
  }
}

async function backup(env, summary) {
  await ensureProject(env, summary.project);
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const requested = cliOption('output', `wai-${stamp}.dump.enc`);
  const output = withinBackups(
    path.isAbsolute(requested) ? requested : path.join(BACKUP_DIR, requested),
  );
  if (!output.endsWith('.dump.enc')) throw new Error('backup output must end with .dump.enc');
  try {
    await stat(output);
    throw new Error(`backup output already exists: ${path.relative(ROOT, output)}`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const plain = await dumpDatabase(env, summary.project, output);
  try {
    await encryptDump(plain, output, env.STAGING_BACKUP_KEY);
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  } finally {
    await rm(plain, { force: true });
  }
  const git = await run('git', ['rev-parse', 'HEAD'], { capture: true });
  const manifest = {
    format: 'wai-pg-custom-aes-256-gcm-v1',
    created_at: new Date().toISOString(),
    project: summary.project,
    database: env.POSTGRES_DB,
    git_sha: git.stdout.trim(),
    ciphertext_sha256: await sha256File(output),
    bytes: (await stat(output)).size,
  };
  await writeJson(output.replace(/\.dump\.enc$/u, '.manifest.json'), manifest);
  console.log(`encrypted backup created: ${path.relative(ROOT, output)} (${manifest.bytes} bytes)`);
  return output;
}

async function userTableCount(env, project) {
  const query =
    "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');";
  const result = await run(
    'docker',
    composeArgs(envFile, project, [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      env.POSTGRES_USER,
      '-d',
      env.POSTGRES_DB,
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    ]),
    { capture: true },
  );
  return Number(result.stdout.trim());
}

async function restoreArchive(env, summary) {
  const rawInput = cliOption('input', '');
  if (!rawInput) throw new Error('restore requires --input=backups/<file>.dump.enc');
  const input = withinBackups(path.isAbsolute(rawInput) ? rawInput : path.join(ROOT, rawInput));
  if (!input.endsWith('.dump.enc')) throw new Error('restore input must end with .dump.enc');
  await ensureProject(env, summary.project);
  const count = await userTableCount(env, summary.project);
  if (count > 0 && cliOption('confirm-overwrite', '') !== summary.project) {
    throw new Error(
      `database has ${count} user tables; repeat with --confirm-overwrite=${summary.project}`,
    );
  }
  const manifest = JSON.parse(
    await readFile(input.replace(/\.dump\.enc$/u, '.manifest.json'), 'utf8'),
  );
  if (
    manifest.project !== summary.project &&
    cliOption('accept-source-project', '') !== manifest.project
  ) {
    throw new Error(
      `backup came from ${String(manifest.project)}; repeat with --accept-source-project=${String(manifest.project)}`,
    );
  }
  if ((await sha256File(input)) !== manifest.ciphertext_sha256)
    throw new Error('backup checksum mismatch');
  const plain = `${input}.restore.tmp`;
  await decryptDump(input, plain, env.STAGING_BACKUP_KEY);
  try {
    await run('docker', composeArgs(envFile, summary.project, ['stop', 'web', 'api', 'worker']));
    const args = composeArgs(envFile, summary.project, [
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      env.POSTGRES_USER,
      '-d',
      env.POSTGRES_DB,
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
    ]);
    const child = spawn('docker', args, {
      cwd: ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: false,
    });
    await Promise.all([
      pipeline(createReadStream(plain), child.stdin),
      waitForChild(child, 'pg_restore'),
    ]);
    await run('docker', composeArgs(envFile, summary.project, ['run', '--rm', 'migrate']));
    await run(
      'docker',
      composeArgs(envFile, summary.project, ['up', '-d', '--wait', 'api', 'worker', 'web']),
    );
    console.log(`restore completed and services restarted from ${path.relative(ROOT, input)}`);
  } finally {
    await rm(plain, { force: true });
  }
}

async function migrate(env, summary) {
  const output = await backup(env, summary);
  console.log(`pre-migration recovery point: ${path.relative(ROOT, output)}`);
  await run('docker', composeArgs(envFile, summary.project, ['run', '--rm', 'migrate']));
  console.log('migrations applied; restore the recovery point to reverse data changes safely');
}

try {
  const env = await loadEnvFile(envFile);
  const summary = validateStagingEnv(env);
  if (command === 'backup') await backup(env, summary);
  else if (command === 'restore') await restoreArchive(env, summary);
  else if (command === 'migrate') await migrate(env, summary);
  else
    throw new Error(
      'usage: staging-data.mjs backup|restore|migrate [--env-file=path] [--input=...] [--confirm-overwrite=project] [--accept-source-project=project]',
    );
} catch (error) {
  console.error(`[staging-data] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
