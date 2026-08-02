import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Fleet failure alerting: 50 consecutive failed runs alerted nobody. The
// contract these tests pin is "an alert is attempted, and the alerter never
// fails" — a non-zero exit here would leave systemd with a failed alert unit
// on top of a failed pipeline unit.

const here = dirname(fileURLToPath(import.meta.url));
const pipelines = join(here, '..');
const script = join(pipelines, 'scripts', 'alert-failure.sh');
const systemdDir = join(pipelines, 'systemd');

let dir: string;
let bin: string;
let capture: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chiya-alert-'));
  bin = join(dir, 'bin');
  capture = join(dir, 'capture');
  stub('journalctl', `printf '%s\\n' "journalctl-args: $*" >> "$CAPTURE.journalctl"\necho "line one from the unit"\necho "line two from the unit"\n`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write an executable stub into the sandbox PATH dir. */
function stub(name: string, body: string): void {
  const path = join(bin, name);
  execFileSync('mkdir', ['-p', bin]);
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

// Args are captured with an explicit separator: the --body argument is
// multi-line (it carries the journal tail), so newline-per-arg would be
// ambiguous.
const ARG_SEP = '\n--CHIYA-ARG--\n';

function gwsStub(exitCode = 0): void {
  stub(
    'gws',
    `for a in "$@"; do printf '%s\\n--CHIYA-ARG--\\n' "$a"; done > "$CAPTURE.gws"\nexit ${exitCode}\n`,
  );
}

function run(
  unit: string,
  env: Record<string, string> = {},
  opts: { withBinDir?: boolean } = {},
): { status: number; stdout: string } {
  const withBin = opts.withBinDir ?? true;
  const result = spawnSync(script, [unit], {
    encoding: 'utf8',
    env: {
      // Sandbox PATH: /usr/bin:/bin has journalctl but NOT gws (which lives in
      // ~/.local/bin), so stubs win and nothing real is ever emailed.
      PATH: withBin ? `${bin}:/usr/bin:/bin` : '/usr/bin:/bin',
      HOME: dir,
      CAPTURE: capture,
      ...env,
    },
  });
  return { status: result.status ?? -1, stdout: `${result.stdout}${result.stderr}` };
}

function sentArgs(): string[] {
  return readFileSync(`${capture}.gws`, 'utf8').split(ARG_SEP).slice(0, -1);
}

/** Value of a `--flag value` pair in the captured gws argv. */
function sentFlag(flag: string): string {
  const args = sentArgs();
  const i = args.indexOf(flag);
  expect(i).toBeGreaterThanOrEqual(0);
  return args[i + 1]!;
}

describe('alert-failure.sh', () => {
  it('is syntactically valid shell', () => {
    expect(() => execFileSync('bash', ['-n', script])).not.toThrow();
    expect(() => execFileSync('sh', ['-n', script])).not.toThrow();
  });

  it('emails the failed unit name and its journal tail', () => {
    gwsStub();
    const r = run('chiya-lint.service', { CHIYA_ALERT_EMAIL: 'ops@example.com' });
    expect(r.status).toBe(0);

    expect(sentArgs().slice(0, 2)).toEqual(['gmail', '+send']);
    expect(sentFlag('--to')).toBe('ops@example.com');
    expect(sentFlag('--subject')).toContain('chiya-lint.service');
    const body = sentFlag('--body');
    expect(body).toContain('chiya unit failed: chiya-lint.service');
    expect(body).toContain('line one from the unit');
    expect(body).toContain('line two from the unit');
  });

  it('reads exactly the last 30 journal lines of that unit', () => {
    gwsStub();
    run('chiya-digest@AM.service', { CHIYA_ALERT_EMAIL: 'ops@example.com' });
    const args = readFileSync(`${capture}.journalctl`, 'utf8');
    expect(args).toContain('--user -u chiya-digest@AM.service -n 30 --no-pager');
  });

  it('falls back to CHIYA_EMAIL_TO when CHIYA_ALERT_EMAIL is unset', () => {
    gwsStub();
    const r = run('chiya-shared.service', { CHIYA_EMAIL_TO: 'reader@example.com' });
    expect(r.status).toBe(0);
    expect(sentFlag('--to')).toBe('reader@example.com');
  });

  it('prefers CHIYA_ALERT_EMAIL over CHIYA_EMAIL_TO', () => {
    gwsStub();
    run('chiya-shared.service', {
      CHIYA_ALERT_EMAIL: 'ops@example.com',
      CHIYA_EMAIL_TO: 'reader@example.com',
    });
    expect(sentFlag('--to')).toBe('ops@example.com');
  });

  it('exits 0 with no recipient configured, and sends nothing', () => {
    gwsStub();
    const r = run('chiya-lint.service');
    expect(r.status).toBe(0);
    expect(existsSync(`${capture}.gws`)).toBe(false);
    expect(r.stdout).toContain('cannot notify');
  });

  it('exits 0 when gws is not installed', () => {
    const r = run('chiya-lint.service', { CHIYA_ALERT_EMAIL: 'ops@example.com' }, {
      withBinDir: false,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gws not on PATH');
  });

  it('exits 0 when the send itself fails', () => {
    gwsStub(1);
    const r = run('chiya-lint.service', { CHIYA_ALERT_EMAIL: 'ops@example.com' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gws send failed');
  });

  it('exits 0 when journalctl fails, still emailing the unit name', () => {
    gwsStub();
    stub('journalctl', 'echo "no such unit" >&2\nexit 1\n');
    const r = run('chiya-nope.service', { CHIYA_ALERT_EMAIL: 'ops@example.com' });
    expect(r.status).toBe(0);
    expect(sentFlag('--body')).toContain('chiya unit failed: chiya-nope.service');
  });

  it('exits 0 with no arguments at all', () => {
    gwsStub();
    const result = spawnSync(script, [], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, CAPTURE: capture },
    });
    expect(result.status).toBe(0);
  });
});

// ---- unit wiring ----------------------------------------------------------

function unit(name: string): string {
  return readFileSync(join(systemdDir, name), 'utf8');
}

const GUARDED = [
  'chiya-shared.service',
  'chiya-librarian.service',
  'chiya-lint.service',
  'chiya-digest@.service',
  'chiya-demand.service',
];

describe('systemd alert wiring', () => {
  it.each(GUARDED)('%s hands failures to chiya-alert@%%n.service', (name) => {
    const text = unit(name);
    expect(text).toContain('OnFailure=chiya-alert@%n.service');
    // Must be in [Unit], not [Service] — systemd ignores it anywhere else.
    const unitSection = text.slice(text.indexOf('[Unit]'), text.indexOf('[Service]'));
    expect(unitSection).toContain('OnFailure=chiya-alert@%n.service');
  });

  it('chiya-alert@.service runs the script with the failed unit name', () => {
    const text = unit('chiya-alert@.service');
    expect(text).toContain('Type=oneshot');
    expect(text).toMatch(/ExecStart=.*scripts\/alert-failure\.sh "%i"/);
    expect(text).toContain('EnvironmentFile=-%h/chiya-library/pipelines/.env');
  });

  it('the alert unit never triggers itself', () => {
    expect(unit('chiya-alert@.service')).not.toMatch(/^OnFailure=/m);
  });

  it('the alert script is executable', () => {
    const mode = execFileSync('stat', ['-c', '%a', script], { encoding: 'utf8' }).trim();
    expect(mode).toMatch(/^7|^5/);
  });
});
