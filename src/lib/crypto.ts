import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'hex');

export function encryptKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv(24 hex) + authTag(32 hex) + ciphertext(hex)
  return iv.toString('hex') + authTag.toString('hex') + encrypted.toString('hex');
}

export function decryptKey(ciphertext: string): string {
  const iv = Buffer.from(ciphertext.slice(0, 24), 'hex');
  const authTag = Buffer.from(ciphertext.slice(24, 56), 'hex');
  const encrypted = Buffer.from(ciphertext.slice(56), 'hex');
  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
