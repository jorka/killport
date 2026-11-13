import { describe, expect, it } from 'vitest';
import { rewriteCommandForPort, withPortEnv } from '../src/portSwitch';

const r = (cmd: string, opts?: Parameters<typeof rewriteCommandForPort>[3]) => rewriteCommandForPort(cmd, 3000, 3001, opts);

describe('rewriteCommandForPort', () => {
  describe('replaces the port when it is written in the command', () => {
    it.each([
      ['vite --port 3000', 'vite --port 3001'],
      ['vite --port=3000 --host', 'vite --port=3001 --host'],
      ['npm run dev -- --port 3000', 'npm run dev -- --port 3001'],
      ['rails s -p 3000', 'rails s -p 3001'],
      ['next dev -p3000', 'next dev -p3001'],
      ['PORT=3000 npm start', 'PORT=3001 npm start'],
      ['$env:PORT=3000; npm start', '$env:PORT=3001; npm start'],
      ['php -S localhost:3000 -t public', 'php -S localhost:3001 -t public'],
      ['python3 -m http.server 3000', 'python3 -m http.server 3001'],
      ['python manage.py runserver 3000', 'python manage.py runserver 3001'],
      ['uvicorn app:app --port 3000 --reload', 'uvicorn app:app --port 3001 --reload'],
      ['serve -l 3000 dist', 'serve -l 3001 dist'],
    ])('%s', (cmd, expected) => {
      expect(r(cmd)).toEqual(expect.objectContaining({ command: expected, how: 'replaced' }));
    });

    it('does not touch numbers that merely contain the port', () => {
      expect(r('vite --port 30001').how).not.toBe('replaced');
      expect(r('node server.js --timeout 30000').how).toBe('env');
    });
  });

  describe('adds the tool flag when the port is not in the command', () => {
    it('vite behind npm run gets `-- --port`', () => {
      expect(r('npm run dev', { processCommand: 'node /app/node_modules/.bin/vite' })).toEqual({ command: 'npm run dev -- --port 3001', how: 'flag', tool: 'vite' });
    });
    it('keeps an existing `--` for npm', () => {
      expect(r('npm run dev -- --host', { processCommand: 'node /app/node_modules/vite/bin/vite.js' }).command).toBe('npm run dev -- --host --port 3001');
    });
    it('pnpm / yarn / bun pass flags straight through', () => {
      expect(r('pnpm dev', { processCommand: 'node /app/node_modules/.bin/../vite/bin/vite.js' }).command).toBe('pnpm dev --port 3001');
      expect(r('yarn dev', { processCommand: 'node /app/node_modules/next/dist/bin/next dev' }).command).toBe('yarn dev --port 3001');
    });
    it.each([
      ['next dev', 'next', 'next dev --port 3001'],
      ['ng serve', 'angular', 'ng serve --port 3001'],
      ['astro dev', 'astro', 'astro dev --port 3001'],
      ['rails server', 'rails', 'rails server -p 3001'],
      ['python manage.py runserver', 'django', 'python manage.py runserver 3001'],
      ['flask run', 'flask', 'flask run --port 3001'],
      ['php artisan serve', 'artisan', 'php artisan serve --port=3001'],
      ['symfony serve', 'symfony', 'symfony serve --port=3001'],
      ['npx http-server dist', 'http-server', 'npx http-server dist -p 3001'],
    ])('%s', (cmd, tool, expected) => {
      expect(r(cmd)).toEqual({ command: expected, how: 'flag', tool });
    });
  });

  describe('falls back to the PORT environment variable', () => {
    it('in each shell syntax', () => {
      expect(r('npm start')).toEqual({ command: 'PORT=3001 npm start', how: 'env' });
      expect(r('node server.js', { shell: 'pwsh' }).command).toBe('$env:PORT=3001; node server.js');
      expect(r('node server.js', { shell: 'cmd' }).command).toBe('set PORT=3001&& node server.js');
    });
    it('makes quoted program paths runnable in PowerShell (call operator)', () => {
      expect(r('"C:\\Program Files\\nodejs\\node.exe" server.js', { shell: 'pwsh' }).command).toBe('$env:PORT=3001; & "C:\\Program Files\\nodejs\\node.exe" server.js');
      expect(r('"C:\\tools\\node.exe" server.js --port 3000', { shell: 'pwsh' }).command).toBe('& "C:\\tools\\node.exe" server.js --port 3001');
      expect(r('npm run dev -- --port 3000', { shell: 'pwsh' }).command).toBe('npm run dev -- --port 3001');
      expect(r('"C:\\tools\\node.exe" server.js', { shell: 'posix' }).command).toBe('PORT=3001 "C:\\tools\\node.exe" server.js');
    });

    it('replaces an existing PORT prefix for another port', () => {
      expect(withPortEnv('PORT=4000 node a.js', 3001, 'posix')).toBe('PORT=3001 node a.js');
    });
  });
});
