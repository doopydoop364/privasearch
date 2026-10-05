// Test-only loopback port remapping for a runtime that refuses privileged bind.
const testPort = Number(process.env.PRIVASEARCH_TEST_PORT ?? 18080);
import net from 'node:net';
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (args[0] === 80 && args[1] === '127.0.0.1') args[0] = testPort;
  return listen.apply(this, args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (options && typeof options === 'object' && Number(options.port) === 80 && (options.host === '127.0.0.1' || options.hostname === '127.0.0.1')) {
    const mapped = {...options,port:testPort};
    if (Array.isArray(args[0])) { args[0]=Object.assign([...args[0]],args[0]); args[0][0]=mapped; } else args[0]=mapped;
  }
  return connect.apply(this, args);
};
