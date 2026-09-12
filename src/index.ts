import { loadConfig } from './config/index.js';
import { createLogger } from './config/logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
logger.info(
  { service: 'drii', mode: 'scaffold' },
  'Shared backend scaffold ready. Slack and intelligence adapters are not connected yet.',
);
