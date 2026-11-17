const host = 'org.amontlabs.lcu.local_browser';
const sessions = new Map();
let connection;

function webUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP(S) URL without embedded credentials.');
  }
  return url;
}

function originOf(url) {
  try { return webUrl(url).origin; } catch { return null; }
}

function state(client) {
  if (!sessions.has(client)) sessions.set(client, { tabs: new Map(), closed: false });
  return sessions.get(client);
}

async function release(client) {
  const session = sessions.get(client);
  if (!session) return;
  sessions.delete(client);
  session.closed = true;
  await Promise.allSettled([...session.tabs.keys()].map(id => chrome.tabs.remove(id)));
}

chrome.tabs.onRemoved.addListener(id => {
  for (const session of sessions.values()) session.tabs.delete(id);
});

async function ownedTab(session, id, verifyOrigin = true) {
  if (session.closed || !session.tabs.has(id)) throw new Error('Select a tab opened by this LCU session.');
  let tab = await chrome.tabs.get(id);
  const origin = session.tabs.get(id);
  if (!verifyOrigin) return tab;
  for (let attempt = 0; attempt < 30 && tab.status === 'loading' &&
      (!tab.pendingUrl || originOf(tab.pendingUrl) === origin); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    tab = await chrome.tabs.get(id);
  }
  if (session.closed || !session.tabs.has(id) || originOf(tab.url) !== origin ||
      (tab.pendingUrl && originOf(tab.pendingUrl) !== origin)) {
    throw new Error('The tab left its approved site. Open the destination separately to approve it.');
  }
  return tab;
}

// Chrome serializes this function into the approved page's isolated extension world.
function pageAction(origin, action, selector, value) {
  if (location.origin !== origin) throw new Error('The page left its approved site.');
  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible';
  if (action === 'snapshot') {
    const candidates = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [contenteditable="true"]');
    const controls = [...candidates].filter(visible).slice(0, 100).map(node => ({
      tag: node.tagName.toLowerCase(), id: node.id || undefined,
      type: node.getAttribute('type') || undefined,
      name: (node.getAttribute('aria-label') || [...(node.labels ?? [])].map(label => label.innerText).join(' ') ||
        (['BUTTON', 'A'].includes(node.tagName) ? node.innerText : '') || node.getAttribute('placeholder') || node.name || '').slice(0, 200),
    }));
    return { title: document.title, text: document.body?.innerText.slice(0, 12000) ?? '', controls };
  }
  const node = document.querySelector(selector);
  if (!node || !visible(node)) throw new Error('The selector did not match a visible element.');
  if (action === 'click') {
    if (node.matches(':disabled, [aria-disabled="true"]')) throw new Error('The element is disabled.');
    const link = node.closest('a[href]');
    const form = node.closest('button:not([type]), button[type="submit"], input[type="submit"]');
    const destination = link?.href || (form?.form && (form.getAttribute('formaction') || form.form.action));
    if (destination && new URL(destination, document.baseURI).origin !== origin) {
      throw new Error('Open the destination separately to approve it.');
    }
    node.click();
    return true;
  }
  if (!node.matches('input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], textarea, [contenteditable="true"]') ||
      node.matches(':disabled, [readonly]')) throw new Error('Select an editable text field.');
  node.focus();
  if (node.isContentEditable) node.textContent = value;
  else Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, value);
  node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

async function perform(session, { action, id, url, selector, value }) {
  if (action === 'open') {
    const target = webUrl(url);
    const tab = await chrome.tabs.create({ url: target.href });
    if (session.closed) {
      await chrome.tabs.remove(tab.id);
      throw new Error('The LCU session closed while the tab opened.');
    }
    session.tabs.set(tab.id, target.origin);
    return { id: tab.id, origin: target.origin };
  }
  if (action === 'list') {
    const tabs = await Promise.allSettled([...session.tabs.keys()].map(tabId => ownedTab(session, tabId)));
    return tabs.filter(tab => tab.status === 'fulfilled').map(({ value: tab }) => ({ id: tab.id, url: tab.url, title: tab.title }));
  }
  if (action === 'close') {
    await ownedTab(session, id, false);
    await chrome.tabs.remove(id);
    return;
  }
  if (!['snapshot', 'fill', 'click', 'screenshot'].includes(action)) throw new Error('Unknown browser action.');
  await ownedTab(session, id);
  if (action === 'screenshot') {
    const target = { tabId: id };
    await chrome.debugger.attach(target, '1.3');
    try {
      await ownedTab(session, id);
      const { data } = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 75 });
      await ownedTab(session, id);
      return data;
    } finally {
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: id }, func: pageAction, args: [session.tabs.get(id), action, selector ?? null, value ?? null],
  });
  if (result === undefined) throw new Error('The browser could not complete the requested page action.');
  return result;
}

function connect() {
  if (connection) return;
  const port = chrome.runtime.connectNative(host);
  connection = port;
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    connection = undefined;
    chrome.action.setBadgeText({ text: 'OFF' });
    for (const client of sessions.keys()) void release(client);
  });
  port.onMessage.addListener(async ({ ready, client, id, request }) => {
    if (connection !== port) return;
    if (ready) {
      await chrome.action.setBadgeText({ text: 'ON' });
      return;
    }
    if (!request) {
      await release(client);
      return;
    }
    let response;
    try { response = { id, value: await perform(state(client), request) }; }
    catch (error) { response = { id, error: error.message }; }
    if (connection === port) port.postMessage(response);
  });
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.action.onClicked.addListener(connect);
