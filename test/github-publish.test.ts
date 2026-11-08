// "Publish to GitHub" (1.0.x): repository names, request checks, the token in git's environment (never on the command line),
// GitHub's error answers, the device-flow poll, the token store, the sign-in order and publishing, all with fakes (no network).
import { describe, expect, it } from 'vitest';
import {
  folderBaseName, isValidRepoName, sanitizeRepoName,
} from '../src/shared/github';

/** A fetch that answers from a list (or a function) and records every request. */

describe('repository names', () => {
  it('suggests a valid name from any folder name', () => {
    expect(sanitizeRepoName('MULTICODING')).toBe('MULTICODING');
    expect(sanitizeRepoName('Mój projekt')).toBe('Moj-projekt');
    expect(sanitizeRepoName('Łódź  -- źródła!!')).toBe('Lodz-zrodla');
    expect(sanitizeRepoName('  spaced out  ')).toBe('spaced-out');
    expect(sanitizeRepoName('site.git')).toBe('site');
    expect(sanitizeRepoName('.dotfiles')).toBe('.dotfiles');
    expect(sanitizeRepoName('trailing.')).toBe('trailing');
    expect(sanitizeRepoName('日本語')).toBe('repository');
    expect(sanitizeRepoName('..')).toBe('repository');
    expect(sanitizeRepoName('a'.repeat(140)).length).toBe(100);
    for (const folder of ['Mój projekt', '日本語', 'a'.repeat(140), '...', '-x-', 'x.git.git']) expect(isValidRepoName(sanitizeRepoName(folder)), folder).toBe(true);
  });

  it('takes the folder name from either kind of path', () => {
    expect(folderBaseName('D:\\Projekty\\MULTICODING\\')).toBe('MULTICODING');
    expect(folderBaseName('/home/a/my app')).toBe('my app');
  });
});

