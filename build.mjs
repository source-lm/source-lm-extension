import esbuild from 'esbuild';
import fs from 'node:fs';

// Optional; a clone without .env falls back to the defaults in src/lib/license.ts.
try {
  process.loadEnvFile('.env');
} catch {}

const ENV_KEYS = [
  'SOURCE_LM_PRICE_LABEL',
  'SOURCE_LM_CHECKOUT_URL',
  'SOURCE_LM_POLAR_ORG_ID',
  'SOURCE_LM_POLAR_API',
  'SOURCE_LM_FREE_QUOTA',
];
// All of them must be defined unconditionally — an undefined one leaves a bare
// `process` reference in the bundle, which throws in the browser.
const define = Object.fromEntries(
  ENV_KEYS.map((k) => [`process.env.${k}`, JSON.stringify(process.env[k] ?? '')]),
);

const targets = [
  ['src/popup/popup.ts', 'dist/popup.js'],
  ['src/content/uploader.ts', 'dist/content.js'],
  ['src/content/youtube.ts', 'dist/youtube.js'],
  ['src/background.ts', 'dist/background.js'],
];

const watch = process.argv.includes('--watch');

for (const [entry, outfile] of targets) {
  if (!fs.existsSync(entry)) {
    console.log(`skip ${entry} (not created yet)`);
    continue;
  }
  const opts = { entryPoints: [entry], outfile, bundle: true, format: 'iife', target: 'chrome120', define };
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log(`watching ${entry}`);
  } else {
    await esbuild.build(opts);
    console.log(`built ${outfile}`);
  }
}
