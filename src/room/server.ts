import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import OpenAI, { toFile } from 'openai';
import { z } from 'zod';
import { loadConfig, type Config } from '../config/index.js';
import { createDatabase } from '../data/database.js';
import { setupSchema } from '../data/schema.js';
import { ClickHouseRecords } from '../data/records.js';
import { ClickHouseDecisionStore } from '../data/decisions.js';
import { ClickHouseSourceStore } from '../data/sources.js';
import { ClickHouseEvidenceRetriever } from '../data/retrieval.js';
import { OpenAIEmbedder } from '../data/embeddings.js';
import { OpenAIReasoningModel } from '../intelligence/model.js';
import { DecisionEngine } from '../intelligence/engine.js';
import {
  DurableDecisionWorkflow,
  WorkflowError,
} from '../intelligence/workflow.js';
import { RoomSessions } from './session.js';
import { RuntimeResources } from '../runtime.js';
import { SHUTDOWN_TIMEOUT_MS } from '../config/limits.js';

export const ROOM_PORT = 3180;
export const MAX_ROOM_BODY = 2_000_000;
async function bytes(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const b = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    size += b.length;
    if (size > MAX_ROOM_BODY) throw new WorkflowError('Request exceeds 2 MB.');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
export function createRoomServer(
  sessions: RoomSessions,
  transcribe: (data: Buffer) => Promise<string>,
  html: string,
  port = ROOM_PORT,
) {
  const token = randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const send = (r: ServerResponse, status: number, value: unknown) => {
    r.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    r.end(JSON.stringify(value));
  };
  return createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) {
        send(res, 403, { error: 'Use the printed loopback address.' });
        return;
      }
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src blob:; frame-ancestors 'none'",
        });
        res.end(html.replace('__ROOM_TOKEN__', token));
        return;
      }
      if (
        req.method !== 'POST' ||
        req.headers.origin !== origin ||
        req.headers['x-room-token'] !== token
      ) {
        send(res, 403, { error: 'Room request not authorized.' });
        return;
      }
      const data = await bytes(req);
      if (req.url === '/api/transcribe') {
        send(res, 200, { text: await transcribe(data) });
        return;
      }
      const body = z
        .object({ id: z.string().uuid().optional() })
        .passthrough()
        .parse(JSON.parse(data.toString('utf8')));
      if (req.url === '/api/start') {
        send(res, 200, await sessions.create());
        return;
      }
      if (!body.id) throw new WorkflowError('Room ID required.');
      if (req.url === '/api/status')
        send(res, 200, await sessions.snapshot(body.id));
      else if (req.url === '/api/segment')
        send(
          res,
          200,
          await sessions.append(
            body.id,
            z
              .object({ segment: z.unknown() })
              .parse(JSON.parse(data.toString('utf8'))).segment,
          ),
        );
      else if (req.url === '/api/review')
        send(res, 200, await sessions.review(body.id));
      else if (
        ['/api/stop', '/api/mute', '/api/dismiss'].includes(req.url ?? '')
      )
        send(
          res,
          200,
          await sessions.control(
            body.id,
            req.url!.slice(5) as 'stop' | 'mute' | 'dismiss',
          ),
        );
      else send(res, 404, { error: 'Route not found.' });
    } catch (error) {
      send(res, error instanceof WorkflowError ? 409 : 400, {
        error:
          error instanceof WorkflowError
            ? error.message
            : 'Room operation failed. Check configuration or retry; no decision was approved.',
      });
    }
  });
}
export async function configuredRoomServer(
  sessions: RoomSessions,
  config: Config,
) {
  const client = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
    baseURL: config.OPENAI_BASE_URL,
  });
  const html = await readFile(
    new URL('./room.html', import.meta.url),
    'utf8',
  ).catch(() =>
    readFile(new URL('../../src/room/room.html', import.meta.url), 'utf8'),
  );
  return createRoomServer(
    sessions,
    async (data) => {
      const response = await client.audio.transcriptions.create(
        {
          file: await toFile(data, 'room.webm', { type: 'audio/webm' }),
          model: config.DRII_ROOM_TRANSCRIPTION_MODEL,
          response_format: 'json',
        },
        { timeout: 30_000, maxRetries: 0 },
      );
      return response.text;
    },
    html,
  );
}
async function main() {
  const config = loadConfig();
  if (!config.OPENAI_API_KEY || !config.DRII_DECISION_OWNER_ID)
    throw new Error('Set OPENAI_API_KEY and DRII_DECISION_OWNER_ID.');
  const db = createDatabase(config);
  const resources = new RuntimeResources();
  resources.defer(() => db.close());
  try {
    await resources.stage('ClickHouse schema setup', () => setupSchema(db));
    const embedder = new OpenAIEmbedder(config);
    const sources = new ClickHouseSourceStore(db, embedder);
    const workflow = new DurableDecisionWorkflow(
      new ClickHouseDecisionStore(db),
      sources,
      new DecisionEngine(
        new OpenAIReasoningModel(config),
        new ClickHouseEvidenceRetriever(
          db,
          embedder,
          config.DRII_MIN_RELEVANCE,
        ),
      ),
    );
    const sessions = new RoomSessions(
      new ClickHouseRecords(db),
      workflow,
      config.DRII_DEMO_WORKSPACE_ID,
      config.DRII_DEMO_PROJECT_ID,
      {
        actorId: config.DRII_DECISION_OWNER_ID,
        displayName: config.DRII_DECISION_OWNER_ID,
        role: 'Configured owner',
      },
    );
    const server = await configuredRoomServer(sessions, config);
    resources.defer(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    await resources.stage(
      'room listener',
      () =>
        new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(ROOM_PORT, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
          });
        }),
    );
    process.stdout.write(
      `Room capture ready at http://127.0.0.1:${ROOM_PORT}. Start capture explicitly in the page.\n`,
    );
    const stop = () => {
      const deadline = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
      deadline.unref();
      void resources.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    const deadline = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    try {
      await resources.close();
    } catch {
      /* Preserve sanitized startup failure. */
    }
    throw error;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main().catch(() => {
    process.stderr.write(
      'Room startup failed. Check local ClickHouse/OpenAI configuration.\n',
    );
    process.exitCode = 1;
  });
