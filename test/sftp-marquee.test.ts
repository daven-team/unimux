import { describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, marqueeRows, marqueeSelect } from '../src/shared/sftpView';

describe('SFTP marquee rows', () => {
  it('returns the rows a band touches, in either drag direction', () => {
    expect(marqueeRows(10, 60, 0, 26, 10)).toEqual({ first: 0, last: 2 });
    expect(marqueeRows(60, 10, 0, 26, 10)).toEqual({ first: 0, last: 2 });
  });

  it('a band inside one row touches that row only; one edge on a row boundary does not touch the next row', () => {
    expect(marqueeRows(30, 31, 0, 26, 10)).toEqual({ first: 1, last: 1 });
    expect(marqueeRows(0, 26, 0, 26, 10)).toEqual({ first: 0, last: 0 });
  });

  it('counts the offset of the ".." row and the scroll (content coordinates)', () => {
    expect(marqueeRows(0, 20, 26, 26, 10)).toBeNull();
    expect(marqueeRows(0, 30, 26, 26, 10)).toEqual({ first: 0, last: 0 });
    expect(marqueeRows(26 * 50 + 5, 26 * 52 + 5, 26, 26, 100)).toEqual({ first: 49, last: 51 });
  });

  it('clamps to the list and gives null below the last row or for an empty list', () => {
    expect(marqueeRows(200, 400, 0, 26, 10)).toEqual({ first: 7, last: 9 });
    expect(marqueeRows(270, 400, 0, 26, 10)).toBeNull();
    expect(marqueeRows(-50, 10, 0, 26, 10)).toEqual({ first: 0, last: 0 });
    expect(marqueeRows(0, 100, 0, 26, 0)).toBeNull();
  });
});

describe('SFTP marquee selection', () => {
  const order = ['/a', '/b', '/c', '/d', '/e'];

  it('selects the touched entries in list order, anchored at the first', () => {
    expect(marqueeSelect({ paths: ['/a'], anchor: '/a', focus: '/a' }, order, ['/c', '/d'], false)).toEqual({ paths: ['/c', '/d'], anchor: '/c', focus: '/d' });
  });

  it('with Ctrl/Cmd adds them to the selection it started from', () => {
    const base = { paths: ['/e', '/a'], anchor: '/e', focus: '/e' };
    expect(marqueeSelect(base, order, ['/b', '/c'], true)).toEqual({ paths: ['/a', '/b', '/c', '/e'], anchor: '/b', focus: '/c' });
    expect(marqueeSelect(base, order, [], true)).toBe(base);
  });

  it('a band that touches nothing clears the selection', () => {
    expect(marqueeSelect({ paths: ['/a'], anchor: '/a', focus: '/a' }, order, [], false)).toEqual(EMPTY_SELECTION);
  });
});
