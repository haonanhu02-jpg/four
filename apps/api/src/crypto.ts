import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt);
  return `scrypt$32768$8$1$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (
    parts.length !== 6 ||
    parts[0] !== 'scrypt' ||
    parts[1] !== '32768' ||
    parts[2] !== '8' ||
    parts[3] !== '1'
  ) {
    return false;
  }
  const salt = parts[4];
  const stored = parts[5];
  if (!salt || !stored || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(stored))
    return false;
  const expected = Buffer.from(stored, 'hex');
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
