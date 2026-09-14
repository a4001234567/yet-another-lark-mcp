/**
 * SSH MCP tools — execute commands on remote machines (Windows & Pi).
 *
 * Connection parameters come from environment variables:
 *   Windows: WIN_SSH_HOST/PORT/USER/KEY  (default port 2226 — frp tunnel)
 *   Pi:      PI_SSH_HOST/PORT/USER/KEY   (default port 2227 — frp tunnel)
 *
 * No secrets are hardcoded in source.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execSync } from 'child_process';

interface SshConfig {
  host: string;
  port: string;
  user: string;
  key: string;
}

function getSshConfig(prefix: string, defaultPort: string, keyLabel: string): SshConfig {
  const host = process.env[`${prefix}_SSH_HOST`] || 'localhost';
  const port = process.env[`${prefix}_SSH_PORT`] || defaultPort;
  const user = process.env[`${prefix}_SSH_USER`] || 'shir0saki';
  const key  = process.env[`${prefix}_SSH_KEY`];
  if (!key) throw new Error(`${prefix}_SSH_KEY not set — configure in ~/.claude/settings.json`);
  return { host, port, user, key };
}

/** Shell-quote a string for SSH: wrap in single quotes, escape embedded single quotes. */
function sshQuote(cmd: string): string {
  return "'" + cmd.replace(/'/g, "'\\''") + "'";
}

function sshExec(command: string, cfg: SshConfig, retries = 2): string {
  const sshCmd = [
    'ssh',
    '-o StrictHostKeyChecking=no',
    '-o ConnectTimeout=10',
    '-o BatchMode=yes',
    '-o PasswordAuthentication=no',
    `-p ${cfg.port}`,
    `-i ${cfg.key}`,
    `${cfg.user}@${cfg.host}`,
    sshQuote(command),
  ].join(' ');
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return execSync(sshCmd, { timeout: 60000, encoding: 'utf-8' });
    } catch (err: any) {
      const isLast = attempt === retries;
      if (isLast || err?.status === 1) throw err; // command error or last attempt — bail
      // Transient failure (spawn timeout, connection refused, etc.) — retry
      const delay = attempt * 500;
      process.stderr.write(`[ssh] attempt ${attempt} failed, retrying in ${delay}ms: ${err?.message ?? err}\n`);
      const deadline = Date.now() + delay;
      while (Date.now() < deadline) { /* spin */ }
    }
  }
  throw new Error('sshExec unreachable');
}

export function registerSshTools(server: McpServer) {
  // -----------------------------------------------------------------------
  // win_exec — Windows machine (via frp tunnel, default port 2226)
  // -----------------------------------------------------------------------
  server.tool(
    'win_exec',
    'Execute a command on the remote Windows machine (shirosaki account). '
    + 'If the command fails with a permission error, shirosaki may need additional access rights — '
    + 'check C:\\Users\\shirosaki\\README.md on the remote machine for resolution steps.',
    {
      command: z.string().describe('Command to execute on the remote Windows machine (e.g. "dir", "arm-none-eabi-gcc --version")'),
      cwd: z.string().optional().describe('Working directory for the command (e.g. "C:\\Users\\zzyzz\\Documents\\STM32\\waveform-gen")'),
    },
    async ({ command, cwd }) => {
      try {
        const cfg = getSshConfig('WIN', '2226', 'WIN_SSH_KEY');
        const fullCmd = cwd ? `cd /d ${JSON.stringify(cwd)} && ${command}` : command;
        const output = sshExec(fullCmd, cfg);
        return { content: [{ type: 'text', text: output }] };
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (msg.includes('permission denied') || msg.includes('Permission denied') || msg.includes('access is denied') || msg.includes('Access is denied') || msg.includes('拒绝访问')) {
          return {
            content: [{
              type: 'text',
              text: `Permission denied: ${msg}\n\nTo resolve this, connect to the Windows machine as shirosaki and read C:\\Users\\shirosaki\\README.md for instructions on granting the required permissions.`,
            }],
          };
        }
        return { content: [{ type: 'text', text: `Error: ${msg}` }] };
      }
    },
  );

  // -----------------------------------------------------------------------
  // pi_exec — Raspberry Pi 5 (via frp tunnel, default port 2227)
  // -----------------------------------------------------------------------
  server.tool(
    'pi_exec',
    'Execute a command on the remote Raspberry Pi 5 (shir0saki account). '
    + 'Connection goes through the frp tunnel on port 2227.',
    {
      command: z.string().describe('Command to execute on the Pi (e.g. "ls -la", "systemctl status frpc")'),
    },
    async ({ command }) => {
      try {
        const cfg = getSshConfig('PI', '2227', 'PI_SSH_KEY');
        const output = sshExec(command, cfg);
        return { content: [{ type: 'text', text: output }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }] };
      }
    },
  );
}
