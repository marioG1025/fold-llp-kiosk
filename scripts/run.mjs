import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getUpstream } from './setup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2] ?? 'server.mjs';
process.env.LLP_ROOT ??= getUpstream();
// Preserve normal process.argv semantics for tools with options.
process.argv.splice(1, 2, resolve(root, target));
await import(pathToFileURL(process.argv[1]));
