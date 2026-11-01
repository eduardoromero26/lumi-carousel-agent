import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { config } from './config.js';

let child: ChildProcess | undefined;

// Starts GIMP without a UI (gimp-console) and runs the gimp-mcp plugin's server
// procedure in it. The procedure never returns (it runs the socket loop), which
// keeps gimp-console alive. A GIMP already listening on the port is reused.
export async function ensureGimp(): Promise<'reused' | 'started'> {
  if (await portOpen()) return 'reused';
  if (!config.gimpConsole) {
    throw new Error('GIMP is not running. Set GIMP_CONSOLE in server/.env or open GIMP and run Tools > MCP > Start MCP Server.');
  }
  const startServer = [
    'from gi.repository import Gimp',
    "p = Gimp.get_pdb().lookup_procedure('plug-in-mcp-server')",
    'c = p.create_config()',
    "c.set_property('run-mode', Gimp.RunMode.NONINTERACTIVE)",
    'p.run(c)',
  ].join('; ');
  child = spawn(config.gimpConsole, ['-i', '--batch-interpreter=python-fu-eval', '-b', startServer], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Own process group on Linux/macOS so stopGimp can kill the plugin too.
    detached: process.platform !== 'win32',
  });
  child.stdout?.on('data', (d: Buffer) => process.env.GIMP_LOG && process.stdout.write(`[gimp] ${d}`));
  child.stderr?.on('data', (d: Buffer) => process.env.GIMP_LOG && process.stderr.write(`[gimp] ${d}`));
  child.on('exit', (code) => {
    console.log(`gimp-console exited (${code})`);
    child = undefined;
  });

  for (let i = 0; i < 90; i++) {
    if (await portOpen()) return 'started';
    if (!child) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  stopGimp();
  throw new Error(`gimp-console did not open port ${config.gimpPort}. Run with GIMP_LOG=1 to see its output.`);
}

// The plugin runs in its own python process that holds the port, so the whole
// process tree has to go, not just gimp-console.
export function stopGimp(): void {
  if (child?.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill();
      }
    }
  }
  child = undefined;
}

// A GIMP that holds the port but doesn't answer (its plugin outlived it): whatever
// listens on the port goes, and a fresh one starts.
export async function restartGimp(): Promise<void> {
  stopGimp();
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout ?? '';
    const pids = new Set(out.split('\n').filter((l) => l.includes(`:${config.gimpPort} `) && /LISTENING/.test(l)).map((l) => l.trim().split(/\s+/).pop()));
    for (const pid of pids) if (pid && /^\d+$/.test(pid)) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
  } else {
    spawnSync('fuser', ['-k', `${config.gimpPort}/tcp`], { stdio: 'ignore' });
  }
  for (let i = 0; i < 20 && (await portOpen()); i++) await new Promise((r) => setTimeout(r, 500));
  await ensureGimp();
}

function portOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: config.gimpPort });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
