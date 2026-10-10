// MG6 prototype only: does sending to a LAN host need Local Network approval? Sends UDP to the
// default gateway and opens TCP to it on 80, and reports each result or errno. Run it under the
// host app chain (responsible app: VidVNC MG3 Host) and from a shell, and compare.
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';

// MG_LAN_HOST: another LAN host instead of the default gateway.
const gateway = process.env.MG_LAN_HOST ?? /gateway: (\S+)/.exec(execFileSync('/sbin/route', ['-n', 'get', 'default'], { encoding: 'utf8' }))?.[1];
const udp = await new Promise((resolve) => {
  const socket = createSocket('udp4');
  socket.send(Buffer.from('mg6'), 9, gateway, (error) => {
    socket.close();
    resolve(error ? `${error.code} ${error.message}` : 'sent');
  });
});
const tcp = await new Promise((resolve) => {
  const socket = connect({ host: gateway, port: 80, timeout: 3000 });
  socket.on('connect', () => (socket.destroy(), resolve('connected')));
  socket.on('timeout', () => (socket.destroy(), resolve('timed out')));
  socket.on('error', (error) => resolve(`${error.code} ${error.message}`));
});
console.log(JSON.stringify({ test: 'lan-outbound', gateway, udp, tcp, pid: process.pid }));

// The same from a native binary built with the macOS 27 SDK.
const probe = new URL('./build-xcode/Release/mg4-probe', import.meta.url).pathname;
console.log(execFileSync(probe, ['--lan-send', gateway], { encoding: 'utf8' }).trim());
