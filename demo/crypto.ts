import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// The domain workflow uses synchronous SHA-256 IDs. Keep those IDs identical
// in the browser without bringing Node or a backend client into this bundle.
export function createHash(algorithm: string) {
  if (algorithm !== 'sha256')
    throw new Error('Unsupported demo hash algorithm');
  const hash = sha256.create();
  return {
    update(value: string) {
      hash.update(new TextEncoder().encode(value));
      return this;
    },
    digest(encoding: string) {
      if (encoding !== 'hex') throw new Error('Unsupported demo hash encoding');
      return bytesToHex(hash.digest());
    },
  };
}

export const randomUUID = () => globalThis.crypto.randomUUID();
