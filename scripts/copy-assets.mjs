import { copyFile } from 'node:fs/promises';
import { URL } from 'node:url';
await copyFile(
  new URL('../src/room/room.html', import.meta.url),
  new URL('../dist/room/room.html', import.meta.url),
);
