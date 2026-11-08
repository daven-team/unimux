// The Monitor panel's pure logic: snapshot parsing, CPU between two snapshots, the app and cell trees, what may be killed.
import { describe, expect, it } from 'vitest';
import {
  formatBytes, formatCpu,
} from '../src/shared/monitor';

describe('labels', () => {
  it('formats memory and CPU', () => {
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(12.34 * 1024 * 1024)).toBe('12.3 MB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(formatCpu(12.345)).toBe('12.3%');
    expect(formatCpu(NaN)).toBe('0.0%');
  });
});
