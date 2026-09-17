import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guard, LOCKOUT_MS, MAX_FAILURES } from '../src/api/admin-guard.ts';

/**
 * The two locks that are not the token, asked directly.
 *
 * They are pure on purpose — an address comparison that is subtly wrong, or a
 * lockout that never lifts, is a failure no request log will ever show you, and
 * a test that went through a socket could not tell a rule that matched from a
 * rule that was never consulted.
 *
 * The clock is injected for the same reason: a lockout is a thing about time,
 * and a test that had to wait fifteen minutes would not be written.
 */

test('no list at all means every address may knock', () => {
  // The token is the gate; this is the second lock, and a deployment that did
  // not set it is still guarded. That is the honest reading and the one the
  // default has to give, or leaving a setting alone would close the port.
  const open = guard('');

  assert.equal(open.allowed('127.0.0.1'), true);
  assert.equal(open.allowed('10.1.2.3'), true);
  assert.equal(open.allowed('::1'), true);
});

test('an address is allowed by name, and nothing else is', () => {
  const one = guard('10.0.0.5');

  assert.equal(one.allowed('10.0.0.5'), true);
  assert.equal(one.allowed('10.0.0.6'), false);
  assert.equal(one.allowed('10.0.0.50'), false, 'and a prefix is not a match');
});

test('a block holds the addresses inside it and not the one past its edge', () => {
  const block = guard('10.0.0.0/8');

  assert.equal(block.allowed('10.0.0.1'), true);
  assert.equal(block.allowed('10.255.255.255'), true, 'the last address in it');
  assert.equal(block.allowed('11.0.0.0'), false, 'the first one past it');
  assert.equal(block.allowed('9.255.255.255'), false, 'and the one before');

  // The edge that a hand-rolled mask gets wrong most often: a /32 has no room,
  // and a /0 has all of it.
  assert.equal(guard('10.0.0.5/32').allowed('10.0.0.5'), true);
  assert.equal(guard('10.0.0.5/32').allowed('10.0.0.6'), false);
  assert.equal(guard('0.0.0.0/0').allowed('203.0.113.9'), true);
});

test('an IPv4 address written the way a socket reports it is still that address', () => {
  // A socket reached over IPv4 on a machine with IPv6 reports `::ffff:10.0.0.5`,
  // and a rule written as `10.0.0.5` would refuse the very machine it names if
  // the two were compared as strings. This is the failure that would have looked
  // like an allowlist that "does not work".
  assert.equal(guard('10.0.0.5').allowed('::ffff:10.0.0.5'), true);
  assert.equal(guard('10.0.0.0/8').allowed('::ffff:10.9.9.9'), true);
  assert.equal(guard('::ffff:10.0.0.5').allowed('10.0.0.5'), true, 'and the other way round');
});

test('the two families are separate, and a rule for one does not hold the other', () => {
  // `10.0.0.0/8` is a statement about IPv4. Folding the families into one number
  // space would have it match `::10.0.0.1`, which is a different machine.
  assert.equal(guard('10.0.0.0/8').allowed('::10.0.0.1'), false);
  assert.equal(guard('::1').allowed('127.0.0.1'), false);
  assert.equal(guard('::1').allowed('::1'), true);
  assert.equal(guard('2001:db8::/32').allowed('2001:db8:1234::5'), true);
  assert.equal(guard('2001:db8::/32').allowed('2001:db9::1'), false);
});

test('a list forgives spacing and a trailing comma', () => {
  // A settings file written by a person has a space after the comma and often a
  // comma at the end. Neither is a reason for the operator to be locked out of
  // their own server by their own allowlist.
  const list = guard(' 10.0.0.1 , 192.0.2.0/24 , ');

  assert.equal(list.allowed('10.0.0.1'), true);
  assert.equal(list.allowed('192.0.2.55'), true);
  assert.equal(list.allowed('8.8.8.8'), false);
});

test('a rule nobody can read is refused while the guard is built', () => {
  // The alternative is worse than a refusal: a rule that silently matches
  // nothing closes a port the operator believes is open, and one that silently
  // matches everything opens one they believe is closed. The sentence reaches
  // them at startup, where they can do something about it.
  assert.throws(() => guard('10.0.0.0/33'), /not an address or a CIDR block/);
  assert.throws(() => guard('10.0.0.0/-1'), /not an address or a CIDR block/);
  assert.throws(() => guard('nowhere/8'), /not an address or a CIDR block/);
  assert.throws(() => guard('10.0.0.0/8/8'), /not an address or a CIDR block/);
});

test('an address that cannot be read reaches nothing, not even itself', () => {
  // Sockets report addresses; a value that is not one is a request from
  // somewhere this server does not understand, and the safe reading of "I do not
  // know where this came from" is not "let it in".
  assert.equal(guard('10.0.0.0/8').allowed(''), false);
  assert.equal(guard('10.0.0.0/8').allowed('not an address'), false);
  assert.equal(guard('').allowed('not an address'), true, 'unless the list is empty, which is everybody');
});

test('the failures are counted, and the lockout lifts on its own', () => {
  let clock = 1_000_000;
  const gate = guard('', () => clock);

  for (let attempt = 1; attempt < MAX_FAILURES; attempt += 1) {
    gate.recordFailure('10.0.0.1');
    assert.equal(gate.locked('10.0.0.1'), false, `after ${attempt} failures`);
    assert.equal(gate.failuresLeft('10.0.0.1'), MAX_FAILURES - attempt);
  }

  gate.recordFailure('10.0.0.1');
  assert.equal(gate.locked('10.0.0.1'), true);
  assert.equal(gate.waitFor('10.0.0.1'), LOCKOUT_MS / 1000);

  // Time passing is the whole of what lifts it: a lockout that needed somebody
  // to clear it would be a lockout that outlives the attack and the operator's
  // patience both.
  clock += LOCKOUT_MS - 1;
  assert.equal(gate.locked('10.0.0.1'), true, 'still locked a millisecond before the end');
  clock += 1;
  assert.equal(gate.locked('10.0.0.1'), false);
  assert.equal(gate.waitFor('10.0.0.1'), 0);
});

test('one address being locked out says nothing about another', () => {
  const gate = guard('');

  for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) gate.recordFailure('10.0.0.1');

  assert.equal(gate.locked('10.0.0.1'), true);
  assert.equal(gate.locked('10.0.0.2'), false, 'a neighbour is not punished for it');
  assert.equal(gate.failuresLeft('10.0.0.2'), undefined, 'and has nothing to be told about');
});

test('a right token clears the count', () => {
  // It proves the caller knows the token. A person who mistyped it nine times
  // before getting it right must not be one stranger's attempt away from being
  // shut out of their own server.
  const gate = guard('');

  for (let attempt = 0; attempt < MAX_FAILURES - 1; attempt += 1) gate.recordFailure('10.0.0.1');
  gate.recordSuccess('10.0.0.1');

  assert.equal(gate.failuresLeft('10.0.0.1'), undefined);
  gate.recordFailure('10.0.0.1');
  assert.equal(gate.failuresLeft('10.0.0.1'), MAX_FAILURES - 1);
  assert.equal(gate.locked('10.0.0.1'), false);
});
