import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_ENV_FILE,
  ROOT,
  cliOption,
  composeArgs,
  loadEnvFile,
  run,
  validateStagingEnv,
  writeJson,
} from './staging-lib.mjs';

const command = process.argv[2];
const envFile = path.resolve(ROOT, cliOption('env-file', path.relative(ROOT, DEFAULT_ENV_FILE)));
process.env['STAGING_RUNTIME_ENV_FILE'] = envFile;
const stateFile = path.join(ROOT, 'deploy', 'staging.release.json');

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function currentState() {
  return (await exists(stateFile)) ? JSON.parse(await readFile(stateFile, 'utf8')) : null;
}

async function smoke() {
  await run('node', ['scripts/staging-smoke.mjs', `--env-file=${path.relative(ROOT, envFile)}`]);
}

try {
  const env = await loadEnvFile(envFile);
  const summary = validateStagingEnv(env);
  const childEnv = {
    WAI_IMAGE_TAG: env.WAI_IMAGE_TAG,
    WAI_IMAGE_REPOSITORY: env.WAI_IMAGE_REPOSITORY,
  };
  if (command === 'deploy') {
    await run('docker', ['info'], { capture: true });
    const running = await run(
      'docker',
      composeArgs(envFile, summary.project, ['ps', '-q', 'postgres']),
      { capture: true },
    );
    let recoveryPoint = null;
    if (running.stdout.trim()) {
      const backupName = `pre-release-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}.dump.enc`;
      await run('node', [
        'scripts/staging-data.mjs',
        'backup',
        `--env-file=${path.relative(ROOT, envFile)}`,
        `--output=${backupName}`,
      ]);
      recoveryPoint = `backups/${backupName}`;
    }
    await run(
      'docker',
      composeArgs(envFile, summary.project, ['build', 'migrate', 'api', 'worker', 'web']),
      { env: childEnv },
    );
    await run('docker', composeArgs(envFile, summary.project, ['up', '-d', '--wait']), {
      env: childEnv,
    });
    await smoke();
    const previous = await currentState();
    const git = await run('git', ['rev-parse', 'HEAD'], { capture: true });
    await writeJson(stateFile, {
      current: {
        tag: env.WAI_IMAGE_TAG,
        git_sha: git.stdout.trim(),
        deployed_at: new Date().toISOString(),
        recovery_point: recoveryPoint,
      },
      previous: previous?.current ?? null,
    });
    console.log(`staging deploy recorded: tag=${env.WAI_IMAGE_TAG}`);
  } else if (command === 'rollback') {
    const state = await currentState();
    const tag = cliOption('tag', state?.previous?.tag ?? '');
    if (!tag) throw new Error('no previous release is recorded; pass --tag=<immutable-tag>');
    for (const service of ['api', 'worker', 'web']) {
      await run('docker', ['image', 'inspect', `${env.WAI_IMAGE_REPOSITORY}:${tag}-${service}`], {
        capture: true,
      });
    }
    const rollbackEnv = { ...childEnv, WAI_IMAGE_TAG: tag };
    await run(
      'docker',
      composeArgs(envFile, summary.project, [
        'up',
        '-d',
        '--no-deps',
        '--no-build',
        '--wait',
        'api',
        'worker',
        'web',
      ]),
      { env: rollbackEnv },
    );
    await smoke();
    await writeJson(stateFile, {
      current: {
        tag,
        git_sha: 'image-metadata',
        deployed_at: new Date().toISOString(),
        recovery_point: null,
      },
      previous: state?.current ?? null,
    });
    console.log(
      `application rollback completed: tag=${tag}; database was not destructively downgraded`,
    );
  } else if (command === 'status') {
    console.log(JSON.stringify(await currentState(), null, 2));
    await run('docker', composeArgs(envFile, summary.project, ['ps']));
  } else {
    throw new Error(
      'usage: staging-release.mjs deploy|rollback|status [--env-file=path] [--tag=immutable-tag]',
    );
  }
} catch (error) {
  console.error(`[staging-release] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
