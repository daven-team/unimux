import { describe, expect, it } from 'vitest';
import { parseShellMark } from '../src/shared/shellIntegration';
import { failedExit, statusText } from '../src/shared/statusDetail';

describe('shell prompt marks', () => {
  it('parses A, B, C and D with or without an exit code; ignores other marks', () => {
    expect(parseShellMark('A')).toEqual({ kind: 'A' });
    expect(parseShellMark('B')).toEqual({ kind: 'B' });
    expect(parseShellMark('C')).toEqual({ kind: 'C' });
    expect(parseShellMark('D')).toEqual({ kind: 'D' });
    expect(parseShellMark('D;0')).toEqual({ kind: 'D', code: 0 });
    expect(parseShellMark('D;130')).toEqual({ kind: 'D', code: 130 });
    expect(parseShellMark('D;1;aid=7')).toEqual({ kind: 'D', code: 1 });
    expect(parseShellMark('D;x')).toEqual({ kind: 'D' });
    expect(parseShellMark('E;ls -la')).toBeNull();
    expect(parseShellMark('P;Cwd=/tmp')).toBeNull();
    expect(parseShellMark('')).toBeNull();
  });
});

describe('status labels', () => {
  it('says what the status is about', () => {
    expect(statusText('working', undefined, { kind: 'tool', tool: 'Edit' })).toEqual({ key: 'praca: {tool}', params: { tool: 'Edit' } });
    expect(statusText('working', undefined, undefined)).toEqual({ key: 'pracuje' });
    expect(statusText('working', undefined, { kind: 'subagent', tool: 'Explore' })).toEqual({ key: 'subagent: {name}', params: { name: 'Explore' } });
    expect(statusText('working', undefined, { kind: 'command' })).toEqual({ key: 'polecenie działa' });
    expect(statusText('waiting', 'attention', { kind: 'permission', tool: 'Bash' })).toEqual({ key: 'czeka na zgodę: {tool}', params: { tool: 'Bash' } });
    expect(statusText('waiting', 'attention', { kind: 'question' })).toEqual({ key: 'pyta Cię o coś' });
    expect(statusText('waiting', 'error', undefined, 'rate_limit')).toEqual({ key: 'limit osiągnięty' });
    expect(statusText('waiting', 'error', undefined, 'cli-exited')).toEqual({ key: 'CLI zakończył działanie' });
    expect(statusText('waiting', 'done', undefined)).toEqual({ key: 'czeka na Ciebie' });
    expect(statusText('idle', undefined, { kind: 'exit-code', code: 3 })).toEqual({ key: 'kod wyjścia {code}', params: { code: 3 } });
    // 1.0.7: the exit code of the cell's own process is named; a non-zero code of any kind is an error everywhere.
    expect(statusText('exited', undefined, { kind: 'exit-code', code: 3 })).toEqual({ key: 'zakończony (kod {code})', params: { code: 3 } });
    expect(statusText('exited', undefined, undefined)).toEqual({ key: 'zakończony' });
    expect(failedExit({ kind: 'exit-code', code: 5 })).toBe(true);
    expect(failedExit({ kind: 'cli-exited', code: 1 })).toBe(true);
    expect(failedExit({ kind: 'cli-exited' })).toBe(false);
    expect(failedExit({ kind: 'command' })).toBe(false);
    expect(failedExit(undefined)).toBe(false);
    expect(statusText('idle', undefined, { kind: 'cli-exited', code: 1 })).toEqual({ key: 'CLI zakończył działanie (kod {code})', params: { code: 1 } });
    expect(statusText('idle', undefined, undefined)).toBeNull();
    expect(statusText('exited', undefined, undefined)).toEqual({ key: 'zakończony' });
  });
});
