import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { TableClient } from '@azure/data-tables';

export type Azurite = { table(name: string): TableClient; stop(): Promise<void> };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });
}

function accepting(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// Starts Azurite's Table service on a free loopback port with an in-memory
// store and a random account key, so no well-known emulator key is needed.
export async function startAzurite(): Promise<Azurite> {
  const port = await freePort();
  const account = 'translatortest';
  const key = randomBytes(32).toString('base64');
  const bin = createRequire(import.meta.url).resolve('azurite/dist/src/table/main.js');
  const child: ChildProcess = spawn(
    process.execPath,
    [bin, '--tableHost', '127.0.0.1', '--tablePort', String(port), '--inMemoryPersistence', '--silent'],
    { env: { ...process.env, AZURITE_ACCOUNTS: `${account}:${key}` }, stdio: 'ignore' },
  );
  for (let tries = 0; !(await accepting(port)); tries++) {
    if (tries > 100 || child.exitCode !== null) throw new Error('Azurite did not start');
    await delay(100);
  }
  const connection = `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${key};TableEndpoint=http://127.0.0.1:${port}/${account};`;
  return {
    table: name => TableClient.fromConnectionString(connection, name, { allowInsecureConnection: true }),
    stop: () =>
      new Promise(resolve => {
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}
