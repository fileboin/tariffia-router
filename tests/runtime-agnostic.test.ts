import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The vendored core's public entry point must stay runtime-agnostic.
 *
 * Adapted from the upstream test of the same name. It walks relative imports
 * from `src/core/index.ts` and fails if any reachable file imports a Node
 * built-in or uses a Node global. The upstream README / Worker example / CLI
 * flags / installer checks were dropped because those files are not part of the
 * vendored core.
 *
 * Tariffia modification (2026-10-03): entry point moved to `src/core/index.ts`
 * and the repo-coherence checks were removed.
 */
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/core');

async function reachableFromIndex(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const queue = ['index.ts'];
  while (queue.length) {
    const rel = queue.shift() as string;
    if (files.has(rel)) continue;
    const source = await readFile(resolve(CORE, rel), 'utf8');
    files.set(rel, source);
    for (const m of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const spec = (m[1] as string).replace(/\.js$/, '.ts');
      const next = resolve(dirname(resolve(CORE, rel)), spec);
      queue.push(next.slice(CORE.length + 1));
    }
  }
  return files;
}

describe('the vendored core entry point stays runtime-agnostic', () => {
  test('nothing reachable from index.ts imports a Node built-in', async () => {
    const files = await reachableFromIndex();
    const offenders: string[] = [];
    for (const [file, source] of files) {
      for (const m of source.matchAll(/from\s+'(node:[^']+)'/g)) {
        offenders.push(`${file} imports ${m[1] as string}`);
      }
    }
    assert.deepEqual(offenders, [], offenders.join('; '));
  });

  test('nothing reachable from index.ts reaches for a Node global', async () => {
    // `process.env` is the one that gets added without thinking. A Worker has
    // no process, and the Registry already takes its environment as an option
    // precisely so nobody needs one.
    const files = await reachableFromIndex();
    const offenders: string[] = [];
    for (const [file, source] of files) {
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const global of ['process.env', '__dirname', 'require(']) {
        if (stripped.includes(global)) offenders.push(`${file} uses ${global}`);
      }
    }
    assert.deepEqual(offenders, [], offenders.join('; '));
  });

  test('the walk actually reached the modules it claims to check', async () => {
    // A traversal that silently found nothing would pass both tests above
    // while checking one file. This is the fixture that proves the ruler.
    const files = await reachableFromIndex();
    for (const expected of ['index.ts', 'router.ts', 'mesh.ts', 'gateway.ts', 'providers/openai-compat.ts']) {
      assert.ok(files.has(expected), `${expected} was not reached`);
    }
  });
});
