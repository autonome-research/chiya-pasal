/**
 * Email send via the Google Workspace CLI (`gws gmail +send`).
 *
 * gws's `--body` takes a single string argv. Passing the body via spawn's
 * args array (not shell) avoids quoting/escaping issues entirely — newlines,
 * quotes, unicode all pass through cleanly. HTML mail is enabled explicitly
 * with `--html` after deterministic TypeScript rendering/escaping.
 *
 * Replaces the prior Hermes flow that wrote the body to /tmp/ and used
 * shell substitution.
 */

import { spawn } from 'child_process';

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
}

export async function gwsEmailSend(msg: EmailMessage): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const args = [
      'gmail',
      '+send',
      '--to',
      msg.to,
      '--subject',
      msg.subject,
      '--body',
      msg.body,
    ];
    if (msg.html) args.push('--html');

    const proc = spawn('gws', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => resolve({ ok: false, output: `spawn error: ${err.message}` }));
    proc.on('close', (code) => {
      const output = (stdout + stderr).trim();
      resolve({ ok: code === 0, output });
    });
  });
}
