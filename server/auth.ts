import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const KEYLEN = 64;

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(32).toString('hex');
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPassword(
  password: string,
  storedHash: string,
  salt: string,
): Promise<boolean> {
  try {
    const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
    const stored = Buffer.from(storedHash, 'hex');
    if (derived.length !== stored.length) return false;
    return timingSafeEqual(derived, stored);
  } catch {
    return false;
  }
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
