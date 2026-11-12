import { build } from 'esbuild';
import { chmodSync, copyFileSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// Everything (core, MCP SDK, zod) is bundled so `npx killport-mcp` has no runtime deps.
await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
  define: { __KILLPORT_VERSION__: JSON.stringify(pkg.version) },
  minify: process.argv.includes('--minify'),
  logLevel: 'info',
});
chmodSync('dist/server.js', 0o755);
copyFileSync('../../LICENSE', 'LICENSE');
