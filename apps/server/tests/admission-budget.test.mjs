import test from 'node:test';
import assert from 'node:assert/strict';

async function budgetClass() {
  const module = await import('../src/admission-budget.mjs').catch(() => ({}));
  assert.equal(typeof module.AdmissionBudget, 'function');
  return module.AdmissionBudget;
}

test('twenty rotating-source guesses reserve one generation atomically', async () => {
  const AdmissionBudget = await budgetClass();
  let now = 0;
  const budget = new AdmissionBudget({ clock: () => now, maxSources: 3 });
  const policy = {
    ephemeral: { generation: 'issue-1', globalLimit: 20, sourceLimit: 5 },
    session: null,
  };
  const attempts = Array.from({ length: 20 }, (_, i) =>
    budget.beginKeyStart(`198.51.100.${i}`, policy),
  );
  assert.equal(
    attempts.every((attempt) => attempt.ok),
    true,
  );
  assert.equal(budget.beginKeyStart('198.51.100.40', policy).ok, false);
  attempts.forEach((attempt) => attempt.finish(null, false));
  assert.equal(budget.beginKeyStart('198.51.100.40', policy).ok, false);
  assert.equal(budget.stats().ephemeral.failures, 20);
  assert.ok(budget.stats().ephemeral.sources <= 3);
  const reissued = { ...policy, ephemeral: { ...policy.ephemeral, generation: 'issue-2' } };
  assert.equal(budget.beginKeyStart('198.51.100.40', reissued).ok, true);
  now += 60_001;
  assert.equal(budget.beginKeyStart('198.51.100.41', reissued).ok, true);
});

test('five failed guesses from one source lock it while source eviction never resets global failures', async () => {
  const AdmissionBudget = await budgetClass();
  const budget = new AdmissionBudget({ clock: () => 0, maxSources: 3 });
  const policy = {
    ephemeral: { generation: 'issue', globalLimit: 20, sourceLimit: 5 },
    session: null,
  };
  for (let i = 0; i < 5; i++) {
    const attempt = budget.beginKeyStart('192.0.2.1', policy);
    assert.equal(attempt.ok, true);
    attempt.finish(null, false);
  }
  assert.equal(budget.beginKeyStart('192.0.2.1', policy).ok, false);
  for (const source of ['192.0.2.2', '192.0.2.3', '192.0.2.4']) {
    const attempt = budget.beginKeyStart(source, policy);
    assert.equal(attempt.ok, true);
    attempt.finish(null, false);
  }
  assert.ok(budget.stats().ephemeral.sources <= 3);
  assert.equal(budget.stats().ephemeral.failures, 8);
});

test('spent ephemeral budget cannot block a remaining local session budget or admit a spent code', async () => {
  const AdmissionBudget = await budgetClass();
  const budget = new AdmissionBudget({ clock: () => 0 });
  const policy = {
    ephemeral: { generation: 'setup-1', globalLimit: 1, sourceLimit: 1 },
    session: { generation: 'password-1', globalLimit: 2, sourceLimit: 2 },
  };
  const bad = budget.beginKeyStart('192.0.2.1', policy);
  assert.equal(bad.ok, true);
  bad.finish(null, false);
  const next = budget.beginKeyStart('192.0.2.2', policy);
  assert.equal(next.ok, true);
  assert.equal(next.allowsPurpose('approved-client-setup'), false);
  assert.equal(next.allowsPurpose('session'), true);
  next.finish('session', true);
  assert.equal(budget.stats().session.failures, 1);
});

test('sign-in, registration and status have finite rolling budgets and recover after a minute', async () => {
  const AdmissionBudget = await budgetClass();
  let now = 0;
  const budget = new AdmissionBudget({ clock: () => now, maxSources: 3 });
  for (let i = 0; i < 10; i++) assert.equal(budget.beginSignIn('192.0.2.1', 'client-a').ok, true);
  assert.equal(budget.beginSignIn('192.0.2.1', 'client-a').ok, false);
  assert.equal(budget.beginRegistration('192.0.2.2').ok, true);
  for (let i = 0; i < 60; i++) assert.equal(budget.beginStatus('192.0.2.3').ok, true);
  assert.equal(budget.beginStatus('192.0.2.3').ok, false);
  now += 60_001;
  assert.equal(budget.beginSignIn('192.0.2.1', 'client-a').ok, true);
  assert.equal(budget.beginStatus('192.0.2.3').ok, true);
});

test('a sign-in pre-reservation binds the parsed client ID to a cross-source identity cap', async () => {
  const AdmissionBudget = await budgetClass();
  const budget = new AdmissionBudget();
  for (let i = 0; i < 10; i++) {
    const attempt = budget.beginSignIn(`192.0.2.${i}`);
    assert.equal(attempt.ok, true);
    assert.equal(attempt.assignIdentity('one-client'), true);
  }
  const rotated = budget.beginSignIn('192.0.2.20');
  assert.equal(rotated.ok, true);
  assert.equal(rotated.assignIdentity('one-client'), false);
  assert.equal(rotated.assignIdentity('another-client'), false);
});

test('a host-busy key attempt can release its pending reservation without charging a failure', async () => {
  const AdmissionBudget = await budgetClass();
  const budget = new AdmissionBudget();
  const policy = {
    ephemeral: { generation: 'busy-code', globalLimit: 20, sourceLimit: 5 },
    session: null,
  };
  const attempt = budget.beginKeyStart('192.0.2.1', policy);
  attempt.cancel();
  assert.equal(budget.stats().ephemeral.pending, 0);
  assert.equal(budget.stats().ephemeral.failures, 0);
});

test('IPv4 and IPv4-mapped socket sources share the same per-source budget', async () => {
  const AdmissionBudget = await budgetClass();
  const budget = new AdmissionBudget();
  const policy = {
    ephemeral: { generation: 'mapped', globalLimit: 20, sourceLimit: 5 },
    session: null,
  };
  for (let i = 0; i < 5; i++) budget.beginKeyStart('192.0.2.8', policy).finish(null, false);
  assert.equal(budget.beginKeyStart('::ffff:192.0.2.8', policy).ok, false);
});

test('a backwards clock adjustment cannot age out recent attempts early', async () => {
  const AdmissionBudget = await budgetClass();
  let now = 1_000;
  const budget = new AdmissionBudget({ clock: () => now });
  assert.equal(budget.beginRegistration('192.0.2.1').ok, true);
  now = 0;
  for (let i = 0; i < 9; i++) assert.equal(budget.beginRegistration('192.0.2.1').ok, true);
  now = 60_000;
  assert.equal(budget.beginRegistration('192.0.2.1').ok, false);
});

test('at most four password derivations run and a fifth is refused without queuing', async () => {
  const AdmissionBudget = await budgetClass();
  const budget = new AdmissionBudget();
  const releases = [];
  const blocked = () => new Promise((resolve) => releases.push(resolve));
  const active = Array.from({ length: 4 }, () => budget.withScrypt(blocked));
  await assert.rejects(budget.withScrypt(blocked), /busy/i);
  assert.equal(releases.length, 4);
  releases.forEach((release) => release());
  await Promise.all(active);
  assert.equal(await budget.withScrypt(async () => 'ok'), 'ok');
});
