import { describe, expect, it } from 'vitest';
import { isTrustedLink, linkHost, splitAddress, trustedHosts, withoutTrustedHost, withTrustedHost } from '../src/shared/linkTrust';

describe('trusted terminal link hosts (1.2.5)', () => {
  it('trusts one host with its port, never another port or another host', () => {
    expect(linkHost('http://LocalHost:3000/a?b=1')).toBe('localhost:3000');
    expect(linkHost('file:///C:/x')).toBeNull();
    expect(linkHost('not a url')).toBeNull();
    const list = withTrustedHost([], 'localhost:3000');
    expect(isTrustedLink(list, 'http://localhost:3000/appeal')).toBe(true);
    expect(isTrustedLink(list, 'http://localhost:5173/')).toBe(false);
    expect(isTrustedLink(list, 'https://localhost.evil.com:3000/')).toBe(false);
    expect(withoutTrustedHost(list, 'LOCALHOST:3000')).toEqual([]);
  });

  it('reads any stored value defensively', () => {
    expect(trustedHosts(undefined)).toEqual([]);
    expect(trustedHosts(['a.com', 1, ' A.com ', '', null, 'b.com'])).toEqual(['a.com', 'b.com']);
    expect(isTrustedLink('localhost:3000', 'http://localhost:3000/')).toBe(false);
  });

  it('splits an address so its host can be shown in bold', () => {
    expect(splitAddress('http://localhost:3000/appeal?k=1')).toEqual({ before: 'http://', host: 'localhost:3000', after: '/appeal?k=1' });
    expect(splitAddress('???')).toEqual({ before: '', host: '', after: '???' });
  });
});
