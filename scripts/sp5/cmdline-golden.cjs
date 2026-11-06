// SP5: golden cases of node-pty 1.1.0's argsToCommandLine (the Windows command line of every pty child in 1.1.4), checked by
// unimux-pty's cmdline test. Usage: node scripts/sp5/cmdline-golden.cjs (rewrites the fixture).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent.js');

const B = '\\';
const Q = '"';
const cases = [
  ['file', []], ['file', ['foo']], ['file', ['foo', 'bar']], ['file', ['']], ['file', ['foo bar']],
  ['file', [Q + 'foo bar' + Q]], ['file', [Q + 'foo' + Q]], ['file', ['foo' + Q + 'bar']], ['file', [Q + 'foo bar']],
  ['file', ['foo bar' + Q]], ['file', ['foo' + B + 'bar']], ['file', ['foo' + B]], ['file', ['foo bar' + B]],
  ['file', ['foo' + B + Q + 'bar']], ['file', [' ']], ['file', ['\t']], ['file', ['a\tb']], ['file', [Q]], ['file', [Q + Q]],
  ['C:' + B + 'Program Files' + B + 'PowerShell' + B + '7' + B + 'pwsh.exe', ['-NoLogo']], ['cmd.exe', []],
  ['x', ['ą ę', 'zażółć', '😀 x']], ['x', ['a b' + B + B]], ['x', ['-Command', '& { Write-Host "a b" }']],
  ['claude', ['--mcp-config', 'C:' + B + 'Users' + B + 'a b' + B + 'mcp.json', '--', 'do it']],
];
const rows = cases.map(([file, args]) => ({ file, args, line: argsToCommandLine(file, args) }));
const out = join(__dirname, '..', '..', 'src-tauri', 'crates', 'unimux-pty', 'tests', 'fixtures', 'cmdline.json');
writeFileSync(out, JSON.stringify(rows, null, 1) + '\n');
console.log(`${rows.length} cases -> ${out}`);
