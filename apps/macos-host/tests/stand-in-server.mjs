// A stand-in for the server, for the macOS host's UI and process-tree tests: it speaks the
// owner protocol from the contract examples in apps/server/tests/fixtures/owner-protocol/
// and opens no ports, captures nothing and needs no privacy permission.
//
// Like the real server it reads exactly one approval line first and refuses anything else,
// stops on `{"type":"stop"}` or when stdin closes, and stops when its parent changes
// (parent-watch.mjs). owner-protocol.test.mjs here checks that its replies keep to the
// contract's shapes.
//
// Environment: VIDVNC_STAND_IN_PID_FILE gets its process id; VIDVNC_STAND_IN_NETWORKS=1
// reports a network waiting for confirmation.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';

const fixtures = new URL('../../server/tests/fixtures/owner-protocol/', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const start = load('start.json');
const lines = load('lines.json');
const replies = load('replies.json');

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
if (process.env.VIDVNC_STAND_IN_PID_FILE)
  writeFileSync(process.env.VIDVNC_STAND_IN_PID_FILE, `${process.pid}\n`);

const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
}, 250).unref();

const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const first = await input.next();
if (first.done || !Object.hasOwn(start.accepted, first.value)) {
  process.stderr.write('Owner approval was not received.\n');
  process.exit(2);
}
const sharing = start.accepted[first.value];

const ready = structuredClone(lines.ready[0]);
const access = ready.access;
const policy = ready.policy;
let networks = process.env.VIDVNC_STAND_IN_NETWORKS === '1' ? lines.status[1].networks : [];
access.remoteAccess = sharing === 'remote' && access.publicHostnames.length > 0;
write(ready);

const tick = () => {
  const status = structuredClone(lines.status[0]);
  status.tls = ready.tls;
  if (networks.length) status.networks = networks;
  write(status);
  write({ type: 'clients', ...ready.clients });
};
tick();
const timer = setInterval(tick, 1000);

// The first contract example of each reply, with the command's request id.
const reply = (type, command, fields = {}) =>
  write({ ...replies[type][0], requestId: command.requestId, ...fields });

for await (const line of input) {
  if (line === '{"type":"stop"}') break;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    continue;
  }
  switch (command.type) {
    case 'access-set': {
      for (const key of Object.keys(access))
        if (key !== 'revision' && command[key] !== undefined) access[key] = command[key];
      access.revision += 1;
      reply('access-result', command, { access });
      break;
    }
    case 'policy-set':
      Object.assign(policy, command.policy, { revision: policy.revision + 1 });
      reply('policy-result', command, { policy });
      break;
    case 'network-confirm':
      networks = networks.filter((network) => network.id !== command.id);
      reply('network-confirm-result', command);
      break;
    case 'tls-regenerate':
      write(replies['tls-regenerate-result'][0]);
      break;
    case 'connection-once-create':
    case 'client-setup-create':
    case 'session-password-rotate':
    case 'client-request-command':
    case 'approved-client-command':
    case 'ordinary-sessions-disconnect':
    case 'session-command':
    case 'diagnostics-capability-create': {
      const type = {
        'connection-once-create': 'connection-once-result',
        'client-setup-create': 'client-setup-result',
        'session-password-rotate': 'session-password-result',
        'client-request-command': 'client-command-result',
        'approved-client-command': 'client-command-result',
        'ordinary-sessions-disconnect': 'client-command-result',
        'session-command': 'session-result',
        'diagnostics-capability-create': 'diagnostics-capability-result',
      }[command.type];
      reply(type, command);
      break;
    }
    default:
      break;
  }
}
clearInterval(timer);
process.exit(0);
