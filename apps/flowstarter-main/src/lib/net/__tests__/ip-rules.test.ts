// @vitest-environment node
/**
 * The address rule, on its own, with no network anywhere near it.
 *
 * This is the half of the SSRF fix that is worth testing exhaustively, because
 * it is the half that is pure: `safe-fetch.ts` can only be as good as the
 * question it asks, and the question is one function of one string. Every case
 * below is an address a real attack has used or a spelling that has defeated a
 * real filter — the v6 ones especially, because `::ffff:10.0.0.5` is 10.0.0.5
 * with a different name and a rule that only knew v6 prefixes would let it
 * through.
 */
import { describe, expect, it } from 'vitest';

import { addressRefusal, isIpLiteral, isPublicAddress } from '../ip-rules';

describe('isPublicAddress, IPv4', () => {
  it('accepts addresses that are actually on the internet', () => {
    for (const address of [
      '93.184.216.34',
      '1.1.1.1',
      '8.8.8.8',
      '151.101.1.140',
      '99.63.255.255',
      '100.63.255.255',
      '100.128.0.0',
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('refuses every private, local and reserved range', () => {
    const cases: Array<[string, string]> = [
      ['0.0.0.0', 'this-network'],
      ['10.0.0.5', 'private'],
      ['100.64.0.1', 'carrier-nat'],
      ['127.0.0.1', 'loopback'],
      // Not 127.0.0.1, and every bit as local. A filter that pattern-matches
      // the famous one misses this.
      ['127.1.2.3', 'loopback'],
      // The reason this finding is rated the way it is.
      ['169.254.169.254', 'link-local'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['192.0.0.1', 'protocol-assignment'],
      ['192.0.2.1', 'documentation'],
      ['192.88.99.1', '6to4-relay'],
      ['192.168.1.1', 'private'],
      ['198.18.0.1', 'benchmarking'],
      ['198.51.100.1', 'documentation'],
      ['203.0.113.1', 'documentation'],
      ['224.0.0.1', 'multicast'],
      ['255.255.255.255', 'reserved'],
    ];
    for (const [address, why] of cases) {
      expect(addressRefusal(address), address).toBe(why);
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('refuses the neighbours of the private blocks that are not in them', () => {
    // 172.15 and 172.32 are outside 172.16/12 and are public. A rule that
    // wrote the mask wrong would refuse these, which is a different bug and
    // just as real: it would silently stop reading legitimate customer sites.
    expect(isPublicAddress('172.15.255.255')).toBe(true);
    expect(isPublicAddress('172.32.0.0')).toBe(true);
    expect(isPublicAddress('169.253.0.1')).toBe(true);
    expect(isPublicAddress('11.0.0.1')).toBe(true);
  });

  it('refuses ambiguous and malformed spellings rather than guessing', () => {
    // `010.0.0.1` is 8.0.0.1 to one parser and 10.0.0.1 to another. A
    // destination whose meaning depends on which library reads it is not one
    // we will use.
    for (const address of [
      '010.0.0.1',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      '1.2.3.-1',
      '',
      'not-an-address',
      '0x7f.0.0.1',
      // The decimal form of 127.0.0.1, which several HTTP clients accept.
      '2130706433',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe('isPublicAddress, IPv6', () => {
  it('accepts a routable address', () => {
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicAddress('2a00:1450:4009:81f::200e')).toBe(true);
  });

  it('refuses the local and reserved prefixes', () => {
    const cases: Array<[string, string]> = [
      ['::', 'unspecified'],
      ['::1', 'loopback'],
      ['[::1]', 'loopback'],
      ['fe80::1', 'link-local'],
      ['fe80::1%eth0', 'link-local'],
      ['fc00::1', 'unique-local'],
      ['fd00::1', 'unique-local'],
      ['ff02::1', 'multicast'],
      ['2001:db8::1', 'documentation'],
      ['2001::abcd', 'teredo'],
      ['2001:20::1', 'orchid'],
      ['100::1', 'discard'],
    ];
    for (const [address, why] of cases) {
      expect(addressRefusal(address), address).toBe(why);
    }
  });

  it('unwraps the forms that carry a v4 address inside them', () => {
    // The bypass this product would have been vulnerable to if the v6 rule had
    // been written as a list of v6 prefixes: each of these IS a private v4
    // destination, spelled as v6.
    expect(addressRefusal('::ffff:10.0.0.5')).toBe('private');
    expect(addressRefusal('::ffff:169.254.169.254')).toBe('link-local');
    expect(addressRefusal('::ffff:127.0.0.1')).toBe('loopback');
    expect(addressRefusal('64:ff9b::10.0.0.5')).toBe('private');
    // 6to4 carries its v4 in the prefix: 2002:0a00:0005:: is 10.0.0.5.
    expect(addressRefusal('2002:a00:5::1')).toBe('private');
    // And the mapped form of a genuinely public address is still public.
    expect(isPublicAddress('::ffff:93.184.216.34')).toBe(true);
  });

  it('refuses malformed v6 rather than guessing', () => {
    for (const address of [
      '::ffff::1',
      '1:2:3:4:5:6:7:8:9',
      'fe80:::1',
      'gggg::1',
      '1:2:3:4:5:6:7',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe('isIpLiteral', () => {
  it('separates addresses from names', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
    expect(isIpLiteral('localhost')).toBe(false);
    // A name that looks like an address is a name, and gets resolved.
    expect(isIpLiteral('1.2.3.4.example.com')).toBe(false);
  });
});
