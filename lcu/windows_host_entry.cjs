// Thin lifetime entry point for the original Windows native-pipe host.
// The installer replaces the marker with a require of the module it generated from app.asar.
const cryptoForEntry = require('node:crypto');
const {join} = require('node:path');
const {pathToFileURL} = require('node:url');
const {startLifetimeSignal} = require('./windows-lifetime-host.cjs');
// ORIGINAL_WINDOWS_PIPE_HOST_MODULE

async function start() {
  const helper = process.env.LCU_WRE_HELPER_PATH;
  const transport = process.env.LCU_WRE_TRANSPORT_PATH;
  const cli = process.env.CODEX_CLI_PATH;
  if (!helper || !transport || !cli) throw Error('Windows helper, transport, and Codex CLI paths are required');
  const pipe = `\\\\.\\pipe\\lcu-wre-${cryptoForEntry.randomUUID()}`;
  const transportPath = join(__dirname, 'windows-turn-transport.mjs');
  const {attachTurnCleanup} = await import(pathToFileURL(transportPath).href);
  const {WindowsHelperTransport} = await import(pathToFileURL(transport).href);
  let host;
  const closeTurn = attachTurnCleanup(WindowsHelperTransport, ids => host.closeActiveTurn(ids));
  host = await createPipeHost({
    codexCliPath: cli,
    nativePipeDirectory: pipe,
    windowsHelperPath: helper,
    windowsHelperTransportModulePath: transportPath,
  });
  let lifetime;
  try { lifetime = await startLifetimeSignal(closeTurn); }
  catch (error) { await host.dispose(); throw error; }
  process.stdout.write(JSON.stringify({ready: true, pipePath: host.pipePath,
    lifetimePath: lifetime.address}) + '\n');
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    try { await lifetime.dispose(); } finally { await host.dispose(); }
    process.stdin.pause();
  }
  process.stdin.resume();
  process.stdin.once('end', () => close().catch(error => { console.error(error); process.exitCode = 1; }));
  process.once('SIGINT', () => close().catch(error => { console.error(error); process.exitCode = 1; }));
  process.once('SIGTERM', () => close().catch(error => { console.error(error); process.exitCode = 1; }));
}
start().catch(error => { console.error(error); process.exitCode = 1; });
