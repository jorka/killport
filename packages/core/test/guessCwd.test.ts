import { describe, expect, it } from 'vitest';
import { pathFromCommand, splitWindowsArgs } from '../src/guessCwd';

describe('Windows: project folder from the command line', () => {
  it('splits quoted arguments', () => {
    expect(splitWindowsArgs('"C:\\Program Files\\nodejs\\node.exe" "C:\\my app\\server.js" --port 3000')).toEqual(['C:\\Program Files\\nodejs\\node.exe', 'C:\\my app\\server.js', '--port', '3000']);
  });

  it.each([
    ['"C:\\Program Files\\nodejs\\node.exe" C:\\code\\shop\\node_modules\\vite\\bin\\vite.js', 'C:\\code\\shop', true],
    ['node.exe "D:\\work\\my app\\node_modules\\.bin\\..\\next\\dist\\bin\\next" dev', 'D:\\work\\my app', true],
    ['C:\\Python312\\python.exe C:\\code\\api\\src\\main.py', 'C:\\code\\api\\src\\main.py', false],
    ['node.exe C:\\code\\api\\server.js --port 3000', 'C:\\code\\api\\server.js', false],
    ['node.exe --config=C:\\code\\site\\node_modules\\x\\cfg.js', 'C:\\code\\site', true],
  ])('%s', (cmd, path, insideNodeModules) => {
    expect(pathFromCommand(cmd)).toEqual({ path, insideNodeModules });
  });

  it('gives up when the command has no absolute path (relative script)', () => {
    expect(pathFromCommand('node.exe server.js')).toBeUndefined();
    expect(pathFromCommand('"C:\\Program Files\\nodejs\\node.exe"')).toBeUndefined();
    expect(pathFromCommand(undefined)).toBeUndefined();
  });
});
