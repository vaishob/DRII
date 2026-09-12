import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createDatabase, DatabaseError } from '../src/data/database.js';

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No test server port');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
describe('official ClickHouse HTTP adapter', () => {
  it('bounds requests and surfaces a useful sanitized timeout error', async () => {
    const url = await listen(createServer(() => undefined));
    const db = createDatabase(
      loadConfig({ CLICKHOUSE_URL: url, CLICKHOUSE_TIMEOUT_MS: '100' }),
    );
    try {
      await expect(db.query('SELECT 1')).rejects.toBeInstanceOf(DatabaseError);
    } finally {
      await db.close();
    }
  });
  it('does not include server error text or credentials in public errors', async () => {
    const url = await listen(
      createServer((_req, res) => {
        res.writeHead(500);
        res.end('SECRET SQL CONTENT');
      }),
    );
    const db = createDatabase(
      loadConfig({
        CLICKHOUSE_URL: url,
        CLICKHOUSE_PASSWORD: 'SECRET PASSWORD',
      }),
    );
    try {
      await expect(db.query('SELECT 1')).rejects.toThrow(
        'Check endpoint, credentials',
      );
      await expect(db.query('SELECT 1')).rejects.not.toThrow('SECRET');
    } finally {
      await db.close();
    }
  });
});
