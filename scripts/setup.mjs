import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('../', import.meta.url));
export const upstreamCommit = 'd14ebf9f8d17a45a3619231d4a9c63c00845bf96';
export const upstreamUrl = 'https://github.com/nik190799/live-layer-protocol.git';
const defaultRoot = resolve(base, '.upstream', 'live-layer-protocol');

function run(file, args, cwd) {
  const result = spawnSync(file, args, { cwd, stdio: 'inherit', ...(process.platform === 'win32' && file === 'npm' ? { shell: true } : {}) });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${file} ${args.join(' ')} exited with status ${result.status}`);
}

export function getUpstream() {
  if (process.env.LLP_ROOT) return resolve(process.env.LLP_ROOT);
  return existsSync(defaultRoot) ? defaultRoot : resolve(base, '../live-layer-protocol');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.LLP_ROOT ? resolve(process.env.LLP_ROOT) : defaultRoot;
  if (!existsSync(resolve(root, '.git'))) {
    if (process.env.LLP_ROOT) throw new Error('LLP_ROOT must point to a Live Layer Protocol Git checkout.');
    mkdirSync(dirname(root), { recursive: true });
    run('git', ['clone', '--no-checkout', '--filter=blob:none', upstreamUrl, root], base);
  }
  const selected = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
  if (selected !== upstreamCommit || !existsSync(resolve(root, 'package-lock.json'))) {
    if (process.env.LLP_ROOT) throw new Error(`LLP_ROOT is on ${selected || 'an unknown revision'}. Expected ${upstreamCommit}.`);
    run('git', ['checkout', '--detach', upstreamCommit], root);
  }
  const npmCli = process.env.npm_execpath;
  if (npmCli && /(?:^|[\\/])npm-cli\.js$/i.test(npmCli)) run(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], root);
  else run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], root);
  console.log(`Live Layer Protocol ${upstreamCommit.slice(0, 7)} ready at ${root}`);
}
