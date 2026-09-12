import { loadConfig } from '../config/index.js';
import { createLogger } from '../config/logger.js';
import { createDatabase } from './database.js';
import { setupSchema } from './schema.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const command = process.argv[2];
async function main(): Promise<void> {
  if (command === 'schema') {
    const admin = createDatabase(config, 'default');
    try {
      await admin.command(
        'CREATE DATABASE IF NOT EXISTS {database:Identifier}',
        { database: config.CLICKHOUSE_DATABASE },
      );
    } finally {
      await admin.close();
    }
  }
  const db = createDatabase(config);
  try {
    if (command === 'schema') {
      await setupSchema(db);
      logger.info({ operation: 'schema' }, 'ClickHouse schema ready');
    } else if (command === 'health') {
      await db.query('SELECT 1 AS healthy');
      logger.info({ operation: 'health' }, 'ClickHouse connection healthy');
    } else throw new Error('Use db:setup or db:health');
  } finally {
    await db.close();
  }
}
main().catch((error: unknown) => {
  logger.error({
    operation: command,
    message:
      error instanceof Error
        ? error.message
        : 'Unexpected data command failure',
  });
  process.exitCode = 1;
});
