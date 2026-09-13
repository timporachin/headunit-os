/*
 * What Windows says the phone is playing.
 *
 * A phone paired over Bluetooth A2DP shows up to Windows as a system media
 * session — the one behind the volume flyout — carrying the track and accepting
 * play/pause/next back out over AVRCP. That session is the only thing a
 * browser-based head unit can see, so this provider is the whole bridge to it.
 *
 * The reading is done by windows-media.ps1 beside this file, because the API is
 * WinRT and there is no way into it from Node without a native module. It
 * speaks one JSON object per line on stdout and takes one verb per line on
 * stdin. See that file for why it must run under Windows PowerShell 5.1.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createBackoff } from '../backoff.mjs';

const SCRIPT = path.join(import.meta.dirname, 'windows-media.ps1');

export function createWindowsMediaProvider() {
  let child = null;
  let stopped = false;
  let timer = null;
  let report = () => {};
  const backoff = createBackoff();

  /* Whatever the adapter last complained about. The shell pipes our stderr into
   * a ring buffer that the Settings screen renders on the dashboard, so a
   * failure is said once per occurrence rather than once per retry. */
  let lastComplaint = null;
  const complain = (message) => {
    if (message === lastComplaint) return;
    lastComplaint = message;
    console.error(`[windows-media] ${message}`);
  };

  function launch() {
    if (stopped) return;

    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    child.on('error', (err) => {
      // No powershell.exe at all: not Windows, or a stripped image.
      complain(`could not launch powershell.exe: ${err.message}`);
      child = null;
      report({ state: 'none' });
      retry();
    });

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          complain(`unparseable line: ${line.slice(0, 200)}`);
          continue;
        }
        if (message.error) {
          complain(message.error);
          report({ state: 'none' });
          continue;
        }
        // Real output: the adapter works, so the ladder starts from the bottom
        // again if it ever falls over later.
        backoff.reset();
        lastComplaint = null;
        report(message);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => complain(String(text).trim()));

    child.on('exit', (code) => {
      child = null;
      if (stopped) return;
      complain(`adapter exited with code ${code}`);
      report({ state: 'none' });
      retry();
    });
  }

  function retry() {
    if (stopped || timer) return;
    const seconds = backoff.fail();
    timer = setTimeout(() => { timer = null; launch(); }, seconds * 1000);
    timer.unref?.();
  }

  return {
    id: 'windows',
    label: 'Bluetooth · Windows media session',
    synthetic: false,

    start(onChange) {
      report = onChange;
      stopped = false;
      launch();
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      // Closing stdin is the adapter's own shutdown signal; kill is the backstop.
      child?.stdin.end();
      child?.kill();
      child = null;
    },

    command(verb) {
      if (!child?.stdin.writable) throw new Error('the media adapter is not running');
      child.stdin.write(`${verb}\n`);
    },
  };
}
