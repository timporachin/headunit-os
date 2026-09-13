#!/usr/bin/env node
/*
 * Does the media session still work on this machine?
 *
 * Run it when the Now Playing screen is blank and you want to know whether the
 * problem is the screen or the source:
 *
 *   node apps/nowplaying/selftest.mjs
 *
 * It runs the PowerShell adapter directly — the same script the app runs — and
 * reports what Windows says. That is the whole point: it separates a PowerShell
 * problem (execution policy, the wrong PowerShell, no media session API) from a
 * problem in the app around it.
 *
 * By default it says whether each field was reported without printing the text,
 * so the output can be pasted somewhere without handing over your listening
 * history. Add --track to see the actual title and artist. Nothing is written
 * to disk, and nothing is sent anywhere.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { argv, exit, platform } from 'node:process';

const SCRIPT = path.join(import.meta.dirname, 'providers', 'windows-media.ps1');
const showTrack = argv.includes('--track');
const WAIT_MS = 12_000;

console.log('\n  Now Playing - media source self-test\n');

if (platform !== 'win32') {
  console.error(`  This machine is ${platform}, not Windows.\n`);
  console.error('  Reading what a phone is playing goes through the Windows media session');
  console.error('  API, so there is nothing here to test. On this machine the app runs with');
  console.error('  HEADUNIT_MEDIA=demo, or reports that it has no source.\n');
  exit(1);
}

console.log('  Running the adapter directly. Play something on the phone if it is quiet.\n');

const child = spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
], { stdio: ['pipe', 'pipe', 'pipe'] });

let settled = false;
const complaints = [];

const finish = (code) => {
  if (settled) return;
  settled = true;
  child.stdin.end();
  child.kill();
  exit(code);
};

child.on('error', (err) => {
  console.error(`  Could not launch powershell.exe: ${err.message}\n`);
  console.error('  The adapter needs Windows PowerShell 5.1 (powershell.exe), which ships with');
  console.error('  Windows. PowerShell 7 (pwsh.exe) will not work: awaiting a WinRT call needs');
  console.error('  an extension that .NET Core dropped.\n');
  finish(1);
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (text) => complaints.push(String(text).trim()));

const field = (label, value) => {
  if (value === null || value === undefined || value === '') return `${label.padEnd(12)} not reported`;
  if (showTrack || typeof value !== 'string') return `${label.padEnd(12)} ${value}`;
  return `${label.padEnd(12)} reported (${value.length} characters)`;
};

let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim() || settled) continue;
    let snapshot;
    try {
      snapshot = JSON.parse(line);
    } catch {
      continue;
    }

    if (snapshot.error) {
      console.error(`  The media session API is not available: ${snapshot.error}\n`);
      console.error('  This usually means the machine is older than Windows 10 1809, or that');
      console.error('  the script was run under PowerShell 7 rather than Windows PowerShell 5.1.\n');
      finish(1);
      return;
    }

    console.log('  The media session answered.\n');
    console.log(`    ${field('session', snapshot.sourceApp)}`);
    console.log(`    ${field('state', snapshot.state)}`);
    console.log(`    ${field('title', snapshot.title)}`);
    console.log(`    ${field('artist', snapshot.artist)}`);
    console.log(`    ${field('album', snapshot.album)}`);
    console.log(`    ${field('duration', snapshot.duration === null ? null : `${Math.round(snapshot.duration / 1000)}s`)}`);
    console.log(`    ${field('position', snapshot.position === null ? null : `${Math.round(snapshot.position / 1000)}s`)}`);

    const accepted = ['canPlay', 'canPause', 'canNext', 'canPrevious']
      .filter((k) => snapshot[k])
      .map((k) => k.replace('can', '').toLowerCase());
    console.log(`    ${'controls'.padEnd(12)} ${accepted.length ? accepted.join(', ') : 'none offered'}`);

    console.log('');
    if (snapshot.state === 'none') {
      console.log('  Windows has no media session right now. Start something on the phone and');
      console.log('  run this again — an idle session reports nothing to show.\n');
      finish(1);
      return;
    }
    if (!snapshot.title) {
      console.log('  A session exists but reports no track. Some Bluetooth stacks do this until');
      console.log('  playback actually starts; if it persists, the phone is not sending metadata.\n');
      finish(1);
      return;
    }
    if (snapshot.duration === null) {
      console.log('  Note: no duration was reported, so the screen will hide its progress bar.');
      console.log('  That is normal over Bluetooth and not a fault.\n');
    }

    console.log('  The media source is working on this machine.\n');
    if (!showTrack) console.log('  (Re-run with --track to print the actual title and artist.)\n');
    finish(0);
    return;
  }
});

setTimeout(() => {
  if (settled) return;
  console.error(`  The adapter said nothing within ${WAIT_MS / 1000}s.\n`);
  if (complaints.length) {
    console.error('  It did complain about this:\n');
    for (const line of complaints.slice(-5)) console.error(`    ${line}`);
    console.error('');
  } else {
    console.error('  No output and no error, which usually means PowerShell is blocked from');
    console.error('  running the script at all. Try it by hand to see what it says:\n');
    console.error(`    powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${SCRIPT}\n`);
  }
  finish(1);
}, WAIT_MS).unref?.();
