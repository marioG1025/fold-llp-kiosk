import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sections = [
  ['register', 'Cashier register', 'register-improvements.md'],
  ['backend', 'Orders, inventory and accounting', 'backend-improvements.md'],
  ['operations', 'Kitchen, operations and pickup', 'operations-improvements.md'],
  ['counter', 'Counter display, terminal lab and sales', 'counter-improvements.md'],
];
const descriptions = new Set();
let number = 0;

function cleanDescription(value) {
  return value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replaceAll('**', '').replaceAll('`', '').trim().replace(/\s+·\s*$/, '');
}

function evidenceFrom(value) {
  const citations = [...value.matchAll(/\]\((?:\.\.\/)?([\w./-]+\.[\w]+)(?:[#:][^)]*)?\)/g),
    ...value.matchAll(/`((?:[\w.-]+\/)*[\w.-]+\.[\w]+)(?:[#:][^`]*)?`/g)].map(match => match[1]);
  return [...new Set(citations)].filter(file => !file.includes('..') && existsSync(resolve(root, file)));
}

const output = sections.map(([id, name, filename]) => {
  const path = `docs/${filename}`;
  const markdown = readFileSync(resolve(root, path), 'utf8');
  const changes = markdown.split(/\r?\n/).flatMap(line => {
    const table = /^\s*\|\s*(\d+)\s*\|\s*([^|]+)\|/.exec(line);
    const item = /^\s*(\d+)\.\s+(\S.*)$/.exec(line);
    if (!table && !item) return [];
    const raw = table ? table[2] : item[2].replace(/\s*\[[^\]]+\]\(\.\.\/[^)]+\)/g, '');
    const description = cleanDescription(raw.replace(/\s+`(?:[\w.-]+\/)*[\w.-]+\.[\w]+`(?:\s*,\s*`(?:[\w.-]+\/)*[\w.-]+\.[\w]+`)*\s*\.?$/, ''));
    const evidence = evidenceFrom(line);
    if (descriptions.has(description)) throw new Error(`Duplicate release note: ${description}`);
    descriptions.add(description);
    return [{ number: ++number, description, evidence: evidence.length ? evidence : [path] }];
  });
  if (changes.length !== 25) throw new Error(`${path} must list 25 improvements. Found ${changes.length}.`);
  return { id, name, changes };
});

const destination = resolve(root, 'public/improvements.json');
const content = JSON.stringify(output, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const previous = readFileSync(destination, 'utf8').replaceAll('\r\n', '\n');
  if (previous !== content) throw new Error('Run npm run release:build to regenerate the improvement ledger.');
} else {
  writeFileSync(destination, content);
}
console.log(`Verified ${number} changes across ${output.length} FOLD workstreams.`);
