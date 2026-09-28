import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

// The sources are TypeScript: esbuild.buildSync bundles one module (plus
// whatever it imports) in memory, and the result is imported straight from
// a data: URI — TS runs under plain `node --test`, no compile step, no temp
// files. `entry` is relative to src/, without the extension ('lib/chunker').
export async function bundle(entry) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(srcDir, entry + '.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  const code = result.outputFiles[0].text;
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}
