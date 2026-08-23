import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const port = Number(process.env.WAI_E2E_WORKER_HEALTH_PORT ?? 3190);
const child = spawn(process.execPath, ['apps/worker/dist/main.js'], {
  cwd: new URL('../../../', import.meta.url),
  env: process.env,
  stdio: 'inherit',
});
const server = createServer((_request, response) => {
  response.writeHead(child.exitCode === null ? 200 : 503);
  response.end('worker');
});
server.listen(port, '127.0.0.1');
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve) => server.close(resolve));
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
child.once('exit', (code) => {
  if (code !== 0) process.exitCode = code ?? 1;
});
