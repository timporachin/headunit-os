#!/usr/bin/env node
/*
 * Does the location source still work for this account?
 *
 * Run it when the Family screen goes blank and you want to know whether the
 * problem is the screen or the service:
 *
 *   node apps/family/selftest.mjs
 *
 * It signs in, lists your circles and counts the members, and prints nothing
 * that could not be shown to a stranger — no token, no password, and names only
 * if you ask for them with --names. Nothing is written to disk; this does not
 * touch the token the app itself uses.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import { createLife360Provider, AuthError, RateLimited } from './providers/life360.mjs';

const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(127);
const showNames = argv.includes('--names');

/** Read a line without echoing it, so a password never lands in the scrollback. */
function secret(question) {
  return new Promise((resolve) => {
    stdout.write(question);
    const wasRaw = Boolean(stdin.isRaw);
    if (stdin.isTTY) stdin.setRawMode(true);
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.pause();
          stdout.write('\n');
          return resolve(value);
        }
        if (ch === CTRL_C) { stdout.write('\n'); exit(130); }
        if (ch === BACKSPACE) { value = value.slice(0, -1); continue; }
        value += ch;
      }
      return undefined;
    };
    stdin.resume();
    stdin.on('data', onData);
  });
}

console.log('\n  Family - location source self-test\n');
console.log('  Nothing you type here is saved, and no secret is printed back.\n');

const rl = createInterface({ input: stdin, output: stdout });
const mode = (await rl.question('  Sign in with (1) email and password, or (2) an access token? [1] ')).trim() || '1';

let input;
if (mode === '2') {
  rl.close();
  input = { mode: 'token', token: await secret('  LIFE360_AUTH_TOKEN value: ') };
} else {
  const username = (await rl.question('  Life360 email: ')).trim();
  rl.close();
  input = { mode: 'password', username, password: await secret('  Password: ') };
}

const provider = createLife360Provider();

try {
  console.log('\n  Signing in...');
  await provider.authenticate(input);
  console.log('  Signed in. A token was received and is NOT printed.\n');

  const circles = await provider.listCircles();
  if (!circles.length) {
    console.log('  This account is not in any circle.\n');
    exit(0);
  }

  for (const circle of circles) {
    const members = await provider.listMembers(circle.id);
    const positioned = members.filter((m) => m.lat !== null).length;
    console.log(`  Circle "${circle.name}" - ${members.length} member(s), ${positioned} reporting a position`);
    if (showNames) {
      for (const m of members) {
        const when = m.since ? new Date(m.since).toLocaleString() : 'never';
        console.log(`      ${m.name.padEnd(20)} ${m.lat === null ? 'no position' : 'positioned '}  last reported ${when}`);
      }
    }
  }
  console.log('\n  The API is working for this account.\n');
  if (!showNames) console.log('  (Re-run with --names to list who is in each circle.)\n');
  exit(0);
} catch (err) {
  console.error('');
  if (err instanceof AuthError) {
    console.error(`  Sign-in refused: ${err.message}`);
    console.error('\n  If this account has a verified phone number, the password will never work');
    console.error('  here. Sign in at life360.com and use the LIFE360_AUTH_TOKEN cookie instead.');
  } else if (err instanceof RateLimited) {
    console.error(`  Rate limited or blocked: ${err.message}`);
    console.error('\n  Wait several minutes before trying again. Repeated attempts make it worse.');
  } else {
    console.error(`  Failed: ${err.message}`);
  }
  console.error('');
  exit(1);
}
