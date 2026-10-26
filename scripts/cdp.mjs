// Dev-only CDP driver: drives the running am-hook GUI window (WebView2 remote debugging)
// or any Chromium target, from the command line.
//
//   node scripts/cdp.mjs targets
//   node scripts/cdp.mjs eval --url am-hook --expr "1+1"
//   node scripts/cdp.mjs shot --url tauri --file shot.png
//
// The GUI exposes the port only when AM_HOOK_GUI_CDP is set (see src-tauri/src/windows.rs).

const DEFAULT_PORT = process.env.AM_HOOK_GUI_CDP || '9222';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`);
  return response.json();
}

function pick(targets, match) {
  const pages = targets.filter((target) => target.type === 'page');
  if (!match) return pages[0];
  const hit = pages.find((target) => target.url.includes(match));
  if (!hit) throw new Error(`no page target matching "${match}" (have: ${pages.map((t) => t.url).join(', ')})`);
  return hit;
}

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let message = null;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} ${message.error.data || ''}`));
      else resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => socket.close() };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'targets';
  const port = args.port || DEFAULT_PORT;
  const targets = await listTargets(port);
  if (command === 'targets') {
    for (const target of targets.filter((t) => t.type === 'page')) {
      console.log(`${target.url}\t${target.id}\t${Math.round((target.title || '').length)}`);
    }
    return;
  }
  const target = pick(targets, args.url);
  if (!target) throw new Error('no page target');
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    if (command === 'eval') {
      const expression = args.expr || args._[1];
      const result = await client.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        console.error('EXCEPTION:', result.exceptionDetails.text, result.exceptionDetails.exception?.description || '');
        process.exitCode = 2;
        return;
      }
      const value = result.result?.value;
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      return;
    }
    if (command === 'shot') {
      const { writeFile } = await import('node:fs/promises');
      const result = await client.send('Page.captureScreenshot', { format: 'png' });
      const file = args.file || 'shot.png';
      await writeFile(file, Buffer.from(result.data, 'base64'));
      console.log(file);
      return;
    }
    if (command === 'wait') {
      const expression = args.expr;
      const timeout = Number(args.timeout || 20000);
      const started = Date.now();
      for (;;) {
        const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.result?.value) { console.log('ok'); return; }
        if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${expression}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`unknown command ${command}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
