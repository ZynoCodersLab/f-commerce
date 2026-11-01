import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

function startServer(port: number, env: NodeJS.ProcessEnv = {}, needsEmail = false): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx/esm', 'src/server.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      // A production process refuses to start without these, so the test runs
      // locally keep development settings unless a test asks otherwise.
      NODE_ENV: needsEmail ? 'production' : 'test',
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'F Commerce <team@example.com>',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForOutput(server: ChildProcess, text: string, timeoutMs = 25_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for "${text}"`)),
      timeoutMs,
    );
    const onOutput = (chunk: Buffer) => {
      if (chunk.toString().includes(text)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    server.stdout?.on('data', onOutput);
    server.stderr?.on('data', onOutput);
    server.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForExit(server: ChildProcess, timeoutMs = 25_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.kill();
      reject(new Error('Timed out waiting for the backend to exit'));
    }, timeoutMs);
    server.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    server.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe('backend scaffold', () => {
  it('serves a healthy response through the real server', async () => {
    const port = 4123;
    const server = startServer(port);

    try {
      await waitForOutput(server, `port ${port}`);

      const response = await fetch(`http://127.0.0.1:${port}/health`);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-powered-by')).toBeNull();
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
      await expect(response.json()).resolves.toEqual({
        success: true,
        data: { status: 'ok' },
        message: 'Backend is healthy',
      });
    } finally {
      server.kill();
    }
  }, 30_000);

  it('exits before listening when the database is unreachable', async () => {
    const port = 4124;
    const server = startServer(port, {
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:1/f-commerce',
    });

    let output = '';
    server.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    server.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

    try {
      await expect(waitForExit(server)).resolves.toBe(1);
      expect(output).toContain('Failed to connect to database');
      expect(output).not.toContain(`port ${port}`);
    } finally {
      server.kill();
    }
  }, 30_000);

  // Signals do not exist on Windows, where Node terminates the child instead of
  // delivering a handler; CI runs this test on Linux.
  it.skipIf(process.platform === 'win32')(
    'drains on SIGTERM and exits cleanly',
    async () => {
      const port = 4125;
      const server = startServer(port);

      let output = '';
      server.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      server.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

      try {
        await waitForOutput(server, `port ${port}`);
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        expect(response.status).toBe(200);

        server.kill('SIGTERM');

        await expect(waitForExit(server)).resolves.toBe(0);
        expect(output).toContain('SIGTERM received, shutting down');
        expect(output).toContain('Shutdown complete');
      } finally {
        server.kill();
      }
    },
    30_000,
  );
});
