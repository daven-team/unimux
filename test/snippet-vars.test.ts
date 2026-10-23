import { describe, expect, it } from 'vitest';
import {
  fillSnippetVars, hasSnippetVars, initialSnippetValues, parseSnippetVars, rememberSnippetValues, resolveSnippetBuiltins,
  snippetBuiltinsUsed, snippetDate, snippetUserVars, snippetVarMatches,
} from '../src/shared/snippetVars';

describe('snippet variables', () => {
  it('finds names and defaults in order of first use', () => {
    expect(parseSnippetVars('echo {{name:world}} on {{branch}} and {{ name }} {{other: a b }}')).toEqual([
      { name: 'name', default: 'world' }, { name: 'branch' }, { name: 'other', default: 'a b' },
    ]);
    // A later default fills a name first used without one.
    expect(parseSnippetVars('{{x}} {{x:1}} {{x:2}}')).toEqual([{ name: 'x', default: '1' }]);
    // An empty default is a default.
    expect(parseSnippetVars('{{x:}}')).toEqual([{ name: 'x', default: '' }]);
  });

  it('leaves template syntax that is no variable alone', () => {
    const text = 'helm {{ .Values.x }} {{}} {{ 1abc }} {x} {{a\nb}} {{ {{y}} }}';
    expect(parseSnippetVars(text).map((v) => v.name)).toEqual(['y']);
    expect(fillSnippetVars('{{ .Values.x }} {{}}', {})).toBe('{{ .Values.x }} {{}}');
    expect(hasSnippetVars('no vars {here}')).toBe(false);
    expect(hasSnippetVars('a {{b}}')).toBe(true);
  });

  it('accepts names with letters of any script, digits, dots and dashes', () => {
    expect(parseSnippetVars('{{gałąź}} {{api.url}} {{file-name}} {{_x2}}').map((v) => v.name)).toEqual(['gałąź', 'api.url', 'file-name', '_x2']);
  });

  it('separates the built-ins from the asked variables', () => {
    const text = 'cd {{path}} && git log {{branch}} {{ticket}} {{date}} {{clipboard}} {{project}} {{msg:fix}}';
    expect(snippetUserVars(text)).toEqual([{ name: 'ticket' }, { name: 'msg', default: 'fix' }]);
    expect([...snippetBuiltinsUsed(text)].sort()).toEqual(['branch', 'clipboard', 'date', 'path', 'project']);
  });

  it('fills values, then defaults, then nothing, without filling inserted values again', () => {
    const text = 'echo {{name:world}} on {{branch}} {{missing}}!';
    expect(fillSnippetVars(text, { branch: 'main' })).toBe('echo world on main !');
    expect(fillSnippetVars(text, { name: '', branch: 'dev' })).toBe('echo  on dev !');
    expect(fillSnippetVars('{{a}} {{b}}', { a: '{{b}}', b: '$1 $&' })).toBe('{{b}} $1 $&');
    expect(fillSnippetVars('x {{a}} y {{a:z}}', { a: 'v' })).toBe('x v y v');
  });

  it('reports the place of each match', () => {
    expect(snippetVarMatches('a {{b:c}} d')).toEqual([{ name: 'b', default: 'c', from: 2, to: 9 }]);
  });

  it('prefills the last values, then the defaults', () => {
    const vars = [{ name: 'a', default: 'x' }, { name: 'b' }, { name: 'c', default: 'y' }];
    expect(initialSnippetValues(vars, { a: 'last', c: '' , gone: 'z' })).toEqual({ a: 'last', b: '', c: '' });
    expect(initialSnippetValues(vars, undefined)).toEqual({ a: 'x', b: '', c: 'y' });
    expect(initialSnippetValues(vars, ['bad'])).toEqual({ a: 'x', b: '', c: 'y' });
  });

  it('remembers entered values for names the text still uses', () => {
    const text = '{{a}} {{b}} {{branch}}';
    expect(rememberSnippetValues(undefined, { a: '1', b: '2', branch: 'x' }, text)).toEqual({ a: '1', b: '2' });
    const previous = { a: '1', b: '2', gone: '3' };
    expect(rememberSnippetValues(previous, { a: '9' }, text)).toEqual({ a: '9', b: '2' });
    const same = { a: '1', b: '2' };
    expect(rememberSnippetValues(same, { a: '1', b: '2' }, text)).toBe(same);
    expect(rememberSnippetValues(undefined, {}, 'no vars')).toBeUndefined();
    expect(rememberSnippetValues(undefined, { a: 'x'.repeat(20_000) }, '{{a}}')!.a).toHaveLength(10_000);
  });

  it('formats the date as YYYY-MM-DD in local time', () => {
    expect(snippetDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('works out only the built-ins the text uses, and a failing read gives an empty value', async () => {
    let clipboardReads = 0;
    const source = {
      project: 'unimux', path: 'D:/p/wt', now: new Date(2026, 9, 23),
      branch: async () => 'feature/x',
      clipboard: async () => { clipboardReads++; return 'copied'; },
    };
    expect(await resolveSnippetBuiltins('{{project}} {{path}} {{branch}} {{date}}', source))
      .toEqual({ project: 'unimux', path: 'D:/p/wt', branch: 'feature/x', date: '2026-10-23' });
    expect(clipboardReads).toBe(0);
    expect(await resolveSnippetBuiltins('{{clipboard}}', source)).toEqual({ clipboard: 'copied' });
    expect(await resolveSnippetBuiltins('{{branch}}', { ...source, branch: async () => { throw new Error('no git'); } })).toEqual({ branch: '' });
  });
});
