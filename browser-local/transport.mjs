import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { frame, readFrames } from '../lcu/native_host.mjs';

const timeout = 20000;

export const pipeFor = token => `\\\\.\\pipe\\lcu-local-browser-${createHash('sha256').update(token).digest('hex')}`;

function send(stream, data) {
  return new Promise((resolve, reject) => {
    stream.write(frame(Buffer.from(JSON.stringify(data))), error => error ? reject(error) : resolve());
  });
}

function matchesProof(expected, supplied) {
  return typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}

const proof = (token, role, challenge) => createHmac('sha256', Buffer.from(token, 'hex')).update(`${role}:${challenge}`).digest('hex');

/** One pipe server per browser extension connection. Each accepted pipe owns its tabs. */
export async function serveNativeBridge(address, token, input = process.stdin, output = process.stdout) {
  const requests = new Map();
  const sockets = new Set();
  let stopping = false;
  const server = createServer(async socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    const client = randomUUID();
    const challenge = randomUUID();
    let authenticated = false;
    socket.on('close', () => {
      sockets.delete(socket);
      if (authenticated && !stopping) void send(output, { client }).catch(() => {});
    });
    try {
      await send(socket, { challenge, proof: proof(token, 'host', challenge) });
      for await (const bytes of readFrames(socket)) {
        if (bytes.length > 262144) throw new Error('Browser request is too large.');
        const { key, request } = JSON.parse(bytes.toString('utf8'));
        if (!matchesProof(proof(token, 'client', challenge), key) || !request || typeof request.action !== 'string') break;
        authenticated = true;
        const id = randomUUID();
        const reply = Promise.withResolvers();
        requests.set(id, reply.resolve);
        const timer = setTimeout(() => reply.resolve({ error: 'The browser extension did not answer in time.' }), timeout);
        try {
          await send(output, { client, id, request });
          await send(socket, await reply.promise);
        } finally {
          clearTimeout(timer);
          requests.delete(id);
        }
      }
    } catch {
      // Losing a browser or MCP session closes its pipe and releases only its tabs.
    } finally {
      socket.destroy();
    }
  });
  server.listen(address);
  await once(server, 'listening');
  try {
    await send(output, { ready: true });
    for await (const raw of readFrames(input)) {
      const { id, value, error } = JSON.parse(raw.toString('utf8'));
      requests.get(id)?.(error ? { error } : { value });
    }
  } finally {
    stopping = true;
    server.close();
    for (const resolve of requests.values()) resolve({ error: 'The browser extension disconnected.' });
    for (const socket of sockets) socket.destroy();
  }
}

export function browserLink(address, key) {
  let connection;
  let closed = false;
  let queue = Promise.resolve();

  async function connect() {
    const socket = createConnection(address);
    socket.on('error', () => {});
    const timer = setTimeout(() => socket.destroy(), 5000);
    try {
      await Promise.race([once(socket, 'connect'), once(socket, 'close').then(() => { throw new Error('The pipe closed.'); })]);
      const replies = readFrames(socket)[Symbol.asyncIterator]();
      const hello = await replies.next();
      const { challenge, proof: remoteProof } = JSON.parse(hello.value.toString('utf8'));
      if (closed || typeof challenge !== 'string' || !matchesProof(proof(key, 'host', challenge), remoteProof)) {
        throw new Error('LCU Local Browser could not verify the pipe host.');
      }
      return { socket, replies, clientProof: proof(key, 'client', challenge) };
    } catch {
      socket.destroy();
      throw new Error('LCU Local Browser is disconnected. Load the local extension, then click its toolbar icon.');
    } finally { clearTimeout(timer); }
  }

  async function perform(request) {
    if (closed) throw new Error('The LCU Local Browser session closed.');
    if (!connection || connection.socket.destroyed) connection = await connect();
    const { socket, replies, clientProof } = connection;
    const timer = setTimeout(() => socket.destroy(), timeout + 2000);
    try {
      await send(socket, { key: clientProof, request });
      const reply = await replies.next();
      if (reply.done) throw new Error('The browser extension disconnected. Reconnect it and open a new tab.');
      const { value, error } = JSON.parse(reply.value.toString('utf8'));
      if (error) throw new Error(error);
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    request(request) {
      const result = queue.then(() => perform(request));
      queue = result.catch(() => {});
      return result;
    },
    close() {
      closed = true;
      connection?.socket.destroy();
    },
  };
}
