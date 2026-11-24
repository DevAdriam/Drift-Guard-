import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';

let ephemeralDevKey: Buffer | null = null;

export class SecretDecryptionError extends Error {
  readonly code = 'CREDENTIAL_DECRYPT_FAILED';

  constructor(
    message = 'Stored connection credentials could not be decrypted because the server encryption key changed. Please re-enter the connection URI for this target.'
  ) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

function derivePersistentFallbackKey(): Buffer | null {
  const sqlPassword = process.env.SQL_PASSWORD?.trim();
  if (!sqlPassword) return null;

  const salt = `${process.env.SQL_HOST?.trim() || 'cloudsql'}:${process.env.SQL_DB_NAME?.trim() || 'app_db'}`;
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(sqlPassword, 'utf8'),
      Buffer.from(salt, 'utf8'),
      Buffer.from('driftguard-secret-encryption-v1', 'utf8'),
      32
    )
  );
}

function getCandidateEncryptionKeys(): Buffer[] {
  const keys: Buffer[] = [];
  const configured = process.env.ENCRYPTION_KEY?.trim();
  if (configured && configured.length >= 16) {
    keys.push(crypto.createHash('sha256').update(configured).digest());
  }

  const persistentFallback = derivePersistentFallbackKey();
  if (
    persistentFallback &&
    !keys.some((k) => crypto.timingSafeEqual(k, persistentFallback))
  ) {
    keys.push(persistentFallback);
  }

  if (keys.length === 0) {
    if (!ephemeralDevKey) {
      ephemeralDevKey = crypto.randomBytes(32);
    }
    keys.push(ephemeralDevKey);
  }

  return keys;
}

function getEncryptionKey(): Buffer {
  return getCandidateEncryptionKeys()[0];
}

export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new SecretDecryptionError('Stored secret payload is malformed.');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const encryptedData = Buffer.from(dataB64, 'base64');

  const candidateKeys = getCandidateEncryptionKeys();
  for (const key of candidateKeys) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      // Try next candidate key if available
    }
  }

  throw new SecretDecryptionError();
}

export function canDecryptSecret(ciphertext: string | null | undefined): boolean {
  if (!ciphertext) return false;
  try {
    decryptSecret(ciphertext);
    return true;
  } catch {
    return false;
  }
}

function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const octets = ip.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return true;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:169.254.') ||
      normalized.startsWith('::ffff:192.168.')
    ) {
      return true;
    }
    return false;
  }

  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.local') ||
    lower === 'metadata.google.internal' ||
    lower === 'metadata'
  ) {
    return true;
  }
  if (net.isIP(lower)) {
    return isPrivateOrReservedIp(lower);
  }
  return false;
}

export async function validateSafePublicHost(hostname: string): Promise<void> {
  if (!hostname || isBlockedHostname(hostname)) {
    throw new Error('Target host is restricted to public, non-private addresses.');
  }

  if (!net.isIP(hostname)) {
    let addresses: { address: string }[];
    try {
      addresses = await dns.lookup(hostname, { all: true });
    } catch {
      throw new Error(`Unable to resolve hostname "${hostname}".`);
    }
    if (!addresses.length) {
      throw new Error(`No DNS records found for "${hostname}".`);
    }
    for (const entry of addresses) {
      if (isPrivateOrReservedIp(entry.address)) {
        throw new Error('Target host resolves to a restricted private or loopback network.');
      }
    }
  }
}

export async function validateSafeWebhookUrl(
  rawUrl: string,
  provider: 'slack' | 'discord' | 'webhook'
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Webhook URL must be a valid HTTPS URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use the https:// protocol.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Webhook URL must not embed basic auth credentials.');
  }

  const host = parsed.hostname.toLowerCase();
  if (provider === 'slack' && host !== 'hooks.slack.com') {
    throw new Error('Slack webhooks must target hooks.slack.com.');
  }
  if (
    provider === 'discord' &&
    host !== 'discord.com' &&
    host !== 'discordapp.com'
  ) {
    throw new Error('Discord webhooks must target discord.com or discordapp.com.');
  }

  await validateSafePublicHost(host);
  return parsed;
}

export async function validateSafePostgresUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Connection string must be a valid postgres:// or postgresql:// URI.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('Connection string must start with postgres:// or postgresql://.');
  }

  if (!parsed.hostname) {
    throw new Error('Connection string must include a target hostname.');
  }

  await validateSafePublicHost(parsed.hostname);
  return parsed;
}

export function maskPostgresUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    const port = parsed.port ? `:${parsed.port}` : ':5432';
    const dbName = parsed.pathname.replace(/^\//, '') || 'postgres';
    const userPart = parsed.username ? `${parsed.username}:***@` : '';
    return `${parsed.protocol}//${userPart}${parsed.hostname}${port}/${dbName}`;
  } catch {
    return 'postgresql://***';
  }
}

export function maskWebhookUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    const segments = parsed.pathname.split('/').filter(Boolean);
    const tail = segments.length > 0 ? segments[segments.length - 1] : '';
    const suffix = tail.length > 6 ? `…${tail.slice(-6)}` : '…';
    return `${parsed.origin}/${segments.slice(0, 2).join('/')}/${suffix}`;
  } catch {
    return 'https://***';
  }
}
