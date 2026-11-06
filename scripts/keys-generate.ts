// Writes an Ed25519 key pair for access tokens into .env (created from .env.example if missing).
// Existing keys are never overwritten.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const ENV = '.env';
if (!existsSync(ENV)) writeFileSync(ENV, readFileSync('.env.example', 'utf8'));
let text = readFileSync(ENV, 'utf8');

const has = (key: string) => new RegExp(`^${key}=.+$`, 'm').test(text);
if (has('JWT_PRIVATE_KEY') && has('JWT_PUBLIC_KEY')) {
  console.log('JWT keys already set in .env; nothing changed.');
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const oneLine = (pem: string) => pem.trim().replace(/\n/g, String.raw`\n`);
const values = {
  JWT_PRIVATE_KEY: oneLine(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
  JWT_PUBLIC_KEY: oneLine(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
};
for (const [key, value] of Object.entries(values)) {
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${text}\n${line}\n`;
}
writeFileSync(ENV, text);
console.log('Wrote new JWT keys to .env');
