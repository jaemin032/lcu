import { McpServer } from '../adapters/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { StdioServerTransport } from '../adapters/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { z } from '../adapters/node_modules/zod/index.js';
import { browserLink, pipeFor } from './transport.mjs';

const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const tabId = z.number().int().nonnegative().describe('Tab ID returned by browser_open');
const selector = z.string().trim().min(1).max(1024).describe('CSS selector from the current page snapshot');

export async function serveMcp(token) {
  const server = new McpServer({ name: 'lcu-local-browser', version: '1.0.0' }, {
    instructions: 'Use browser_open for the user-requested URL. Site access needs approval. Use browser_snapshot to locate controls, then browser_fill or browser_click. Only use tabs opened by this connection.',
  });
  const link = browserLink(pipeFor(token), token);
  const origins = new Map();

  function tool(name, description, inputSchema, run) {
    server.registerTool(`browser_${name}`, { description, inputSchema }, async args => {
      try { return await run(args); }
      catch (error) { return { ...text(error.message), isError: true }; }
    });
  }

  tool('open', 'Open an HTTP(S) page in its own tab after approval for the site.', { url: z.string().url().max(8192) }, async ({ url }) => {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
      throw new Error('Use an HTTP(S) URL without embedded credentials.');
    }
    if (!origins.has(target.origin)) {
      const approval = server.server.elicitInput({
        mode: 'form', message: `Allow LCU Local Browser to access ${target.origin} for this connection?`,
        requestedSchema: { type: 'object', properties: {} },
      }).then(({ action }) => action === 'accept').catch(() => false);
      origins.set(target.origin, approval);
    }
    const approval = origins.get(target.origin);
    if (!await approval) {
      if (origins.get(target.origin) === approval) origins.delete(target.origin);
      throw new Error(`Site access was not approved for ${target.origin}.`);
    }
    return text(await link.request({ action: 'open', url: target.href }));
  });

  tool('list', 'List tabs that this connection opened and that are on their approved sites.', {},
    async () => text(await link.request({ action: 'list' })));
  tool('snapshot', 'Read the visible text and controls of an approved tab.', { id: tabId },
    async args => text(await link.request({ action: 'snapshot', ...args })));
  tool('fill', 'Enter text into a visible text field in an approved tab.', { id: tabId, selector, value: z.string().max(20000) }, async args => {
    await link.request({ action: 'fill', ...args });
    return text('Text entered.');
  });
  tool('click', 'Click a visible control in an approved tab.', { id: tabId, selector }, async args => {
    await link.request({ action: 'click', ...args });
    return text('Control clicked.');
  });
  tool('screenshot', 'Capture an image of an approved tab.', { id: tabId }, async args => {
    const data = await link.request({ action: 'screenshot', ...args });
    return { content: [{ type: 'image', mimeType: 'image/jpeg', data }] };
  });
  tool('close', 'Close a tab that this connection opened.', { id: tabId }, async args => {
    await link.request({ action: 'close', ...args });
    return text('Tab closed.');
  });

  server.server.onclose = () => link.close();
  const transport = new StdioServerTransport();
  process.stdin.once('end', () => link.close());
  await server.connect(transport);
}
