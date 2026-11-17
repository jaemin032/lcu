import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { locateCodexTools } from '../lcu/app_layout.mjs';
import { withAppServer } from '../lcu/app_server.mjs';
import { withLock } from '../lcu/lock.mjs';
import { paths } from '../lcu/runtime.mjs';
import { say } from '../lcu/terminal.mjs';
import { pipeFor, serveNativeBridge } from './transport.mjs';

const name = 'org.amontlabs.lcu.local_browser';

function directory(create = false) {
  if (process.platform !== 'win32') throw new Error('LCU Local Browser is available in the Windows x64 release.');
  if (!process.env.LOCALAPPDATA || !isAbsolute(process.env.LOCALAPPDATA)) throw new Error('LOCALAPPDATA must be an absolute path.');
  let destination = realpathSync(process.env.LOCALAPPDATA);
  for (const part of ['LCU', 'local-browser']) {
    destination = join(destination, part);
    if (create) mkdirSync(destination, { recursive: true });
    const info = lstatSync(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('LCU Local Browser needs a private local directory.');
  }
  return destination;
}

function token(destination) {
  const file = join(destination, 'bridge-key');
  if (!lstatSync(file).isFile()) throw new Error('Invalid local browser key file.');
  const key = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid local browser key.');
  return key;
}

function extensionId(key) {
  return [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)]
    .map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

function writeLocalFile(file, data) {
  try {
    if (!lstatSync(file).isFile()) throw new Error(`Refusing to write through ${file}.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  writeFileSync(file, data);
}

async function install(root, agent) {
  const destination = directory(true);
  const extension = join(destination, 'extension');
  const prefix = dirname(dirname(root));
  const launcher = join(prefix, 'windows_launcher.mjs');
  if (!lstatSync(launcher).isFile()) throw new Error('Run local-install from the installed LCU release.');
  await withLock(join(destination, '.install.lock'), async () => {
    try { writeFileSync(join(destination, 'bridge-key'), randomBytes(32).toString('hex'), { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    token(destination);
    mkdirSync(extension, { recursive: true });
    if (!lstatSync(extension).isDirectory()) throw new Error('The extension directory must be local.');
    const source = join(root, 'browser-local', 'extension');
    const manifest = readFileSync(join(source, 'manifest.json'));
    writeLocalFile(join(extension, 'worker.js'), readFileSync(join(source, 'worker.js')));
    writeLocalFile(join(extension, 'manifest.json'), manifest);
    const executable = join(destination, 'local-browser.cmd');
    const stableCmd = join(prefix, 'lcu.cmd').replaceAll('%', '%%');
    writeLocalFile(executable, `@echo off\r\n"${stableCmd}" browser local-native\r\n`);
    const nativeManifest = join(destination, `${name}.json`);
    writeLocalFile(nativeManifest, JSON.stringify({ name, description: 'LCU Local Browser', path: executable, type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId(JSON.parse(manifest).key)}/`] }, null, 2) + '\n');
    const reg = join(process.env.SystemRoot, 'System32', 'reg.exe');
    for (const browser of ['Google\\Chrome', 'Microsoft\\Edge']) {
      execFileSync(reg, ['add', `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${name}`, '/ve', '/t', 'REG_SZ', '/d', nativeManifest, '/f'],
        { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    }
    if (agent) {
      const { resources } = paths(root);
      const codex = locateCodexTools(resources, { windows: true }).cli;
      await withAppServer(codex, prefix, process.env, server => server.call('config/batchWrite', { edits: [
        { keyPath: 'mcp_servers.lcu_local_browser.command', mergeStrategy: 'replace', value: process.execPath },
        { keyPath: 'mcp_servers.lcu_local_browser.args', mergeStrategy: 'replace', value: [launcher, 'browser', 'local-mcp'] },
      ] }));
    }
  });
  say(`LCU Local Browser extension: ${extension}`,
    'In Edge or Chrome, enable Developer mode in the extensions page, select Load unpacked, and choose the folder above.',
    'Load or reload the extension, then click its toolbar icon if its badge shows OFF.',
    agent ? 'Restart Codex and ask it to use lcu_local_browser.' : 'The MCP command is lcu browser local-mcp.');
}

export async function run(root, action, args) {
  if (action === 'local-install') {
    const agent = args.length === 2 && args[0] === '--agent' && args[1] === 'codex';
    if (args.length && !agent) throw new Error('Usage: lcu browser local-install [--agent codex]');
    await install(root, agent);
  } else {
    if (args.length) throw new Error(`lcu browser ${action} takes no arguments.`);
    const key = token(directory());
    if (action === 'local-native') await serveNativeBridge(pipeFor(key), key);
    else await (await import('./mcp.mjs')).serveMcp(key);
  }
  return 0;
}
