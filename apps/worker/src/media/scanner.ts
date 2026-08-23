import net from 'node:net';
import type { MalwareScannerPort, MalwareScanResult } from '@wai/contracts';

/** Deterministic test/dev scanner. Production wiring rejects this adapter. */
export class DeterministicMalwareScanner implements MalwareScannerPort {
  async scan(
    content: Uint8Array,
    options: { timeoutMs: number; maxBytes: number },
  ): Promise<MalwareScanResult> {
    if (content.byteLength > options.maxBytes) return { verdict: 'error' };
    const text = new TextDecoder().decode(content);
    return {
      verdict: text.includes(
        'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
      )
        ? 'infected'
        : 'clean',
      engineVersion: 'deterministic-test-only',
    };
  }
}

/** Minimal clamd INSTREAM adapter. No third-party URL or provider payload is used. */
export class ClamAvScanner implements MalwareScannerPort {
  constructor(
    private readonly host = '127.0.0.1',
    private readonly port = 3310,
  ) {}

  scan(
    content: Uint8Array,
    options: { timeoutMs: number; maxBytes: number },
  ): Promise<MalwareScanResult> {
    if (content.byteLength > options.maxBytes) return Promise.resolve({ verdict: 'error' });
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ verdict: 'timeout' });
      }, options.timeoutMs);
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('error', () => {
        clearTimeout(timer);
        resolve({ verdict: 'error' });
      });
      socket.on('close', () => {
        clearTimeout(timer);
        const verdict = Buffer.concat(chunks).toString('utf8');
        resolve(
          verdict.includes('FOUND')
            ? { verdict: 'infected' }
            : verdict.includes('OK')
              ? { verdict: 'clean' }
              : { verdict: 'error' },
        );
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const buffer = Buffer.from(content);
        socket.write(
          Buffer.concat([
            Buffer.from([
              (buffer.length >>> 24) & 0xff,
              (buffer.length >>> 16) & 0xff,
              (buffer.length >>> 8) & 0xff,
              buffer.length & 0xff,
            ]),
            buffer,
          ]),
        );
        socket.end(Buffer.from([0, 0, 0, 0]));
      });
    });
  }
}
