import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
