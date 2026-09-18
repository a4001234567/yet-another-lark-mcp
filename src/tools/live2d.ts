/**
 * Live2D desktop mascot integration.
 *
 * Sends commands to the user's Live2DViewerEX on Windows via SSH.
 * Runs live2d.py in a venv on the Windows machine, which in turn
 * sends WebSocket messages to Live2DViewerEX at ws://127.0.0.1:10086/api.
 *
 * Usage (from other tool handlers or the reply flow):
 *   import { live2d } from './tools/live2d.js';
 *   await live2d.expression(4);    // 拿笔
 *   await live2d.motion('hand-up');
 *   await live2d.bubble('Hello');
 */

import { execSync, spawn } from 'child_process';

const LIVE2D_SCRIPT = 'C:\\Users\\shirosaki\\live2d\\live2d.py';
const VENV_PYTHON   = 'C:\\Users\\shirosaki\\live2d\\venv\\bin\\python';

interface SshConfig {
  host: string;
  port: string;
  user: string;
  key: string;
}

function getSshConfig(): SshConfig {
  const host = process.env.WIN_SSH_HOST || 'localhost';
  const port = process.env.WIN_SSH_PORT || '2226';
  const user = process.env.WIN_SSH_USER || 'shirosaki';
  const key  = process.env.WIN_SSH_KEY;
  if (!key) throw new Error('WIN_SSH_KEY not set');
  return { host, port, user, key };
}

function sshExec(command: string): string {
  const cfg = getSshConfig();
  const cmd = [
    'ssh',
    '-o StrictHostKeyChecking=no',
    '-o ConnectTimeout=10',
    '-o BatchMode=yes',
    '-o PasswordAuthentication=no',
    `-p ${cfg.port}`,
    `-i ${cfg.key}`,
    `${cfg.user}@${cfg.host}`,
    JSON.stringify(command),
  ].join(' ');
  return execSync(cmd, { timeout: 15000, encoding: 'utf-8' });
}

async function run(args: string): Promise<void> {
  const cmd = `${VENV_PYTHON} ${LIVE2D_SCRIPT} ${args}`;
  try {
    sshExec(cmd);
  } catch {
    // Live2DViewerEX might not be running — fail silently.
    // The user doesn't need a loud error for a cosmetic feature.
  }
}

export const live2d = {
  /** Set expression by ID (0=呆, 1=无, 2=嫌弃, 3=害羞, 4=拿笔, 5=晕, 6=欸嘿, 7=可怜) */
  async expression(id: number): Promise<void> {
    await run(`expression --id ${id}`);
  },

  /** Fire-and-forget expression set that never uses execSync — won't stall the Node
   *  event loop, so it's safe to call at process startup even if the SSH tunnel is
   *  down. Used for the "I received your message" cue (拿笔) under the broker. */
  fireExpression(id: number): void {
    try {
      const cfg = getSshConfig();
      const remote = `${VENV_PYTHON} ${LIVE2D_SCRIPT} expression --id ${id}`;
      spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'BatchMode=yes',
        '-o', 'PasswordAuthentication=no',
        '-p', cfg.port,
        '-i', cfg.key,
        `${cfg.user}@${cfg.host}`,
        remote,
      ], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // best-effort — cosmetic feature
    }
  },

  /** Trigger a named motion (hand-up, hand-down, twist, etc.) */
  async motion(name: string): Promise<void> {
    await run(`motion --name ${name}`);
  },

  /** Display a text bubble (default 10s for tool call bubbles) */
  async bubble(text: string, duration = 10000): Promise<void> {
    const safe = text.replace(/"/g, '\\"');
    await run(`bubble --text "${safe}" --duration ${duration}`);
  },

  /** Fire-and-forget: send a tool call bubble without awaiting.
   *  Use in the MCP tool wrapper — won't block the tool response.
   *  If toolName starts with a symbol (e.g. "⚡"), it's treated as pre-formatted. */
  fireToolBubble(toolName: string, _params: Record<string, unknown>): void {
    const isPreFormatted = /^[^\w]/.test(toolName);
    const text = isPreFormatted ? toolName : `🔧 ${toolName}`;
    const safe = text.replace(/"/g, '\\"');
    try {
      const cfg = getSshConfig();
      const remote = `${VENV_PYTHON} ${LIVE2D_SCRIPT} bubble --text "${safe}" --duration 10000`;
      spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'BatchMode=yes',
        '-o', 'PasswordAuthentication=no',
        '-p', cfg.port,
        '-i', cfg.key,
        `${cfg.user}@${cfg.host}`,
        remote,
      ], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // best-effort
    }
  },
};
