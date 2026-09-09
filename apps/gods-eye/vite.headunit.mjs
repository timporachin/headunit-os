/*
 * God's Eye View, configured to run as an app inside this shell.
 *
 * Upstream serves every page with `X-Frame-Options: DENY` and
 * `Content-Security-Policy: frame-ancestors 'none'`, and that is not
 * incidental — the app has a Provider Settings panel that writes real API keys
 * to disk through POST /api/setup/keys. Without frame-ancestors, a hostile page
 * could frame the app, align a lure over that panel, and have the framed app
 * issue a credential write that passes every Host and Origin check. The header
 * is what makes that attack impossible rather than merely unlikely.
 *
 * So this does NOT remove the protection. It narrows it: the app may be framed
 * by this shell's origin and by nothing else. The shell in turn refuses to be
 * framed at all (see server/index.mjs), so the chain a hostile page would need
 * — frame the shell, which frames the app — is closed at the first link.
 *
 * X-Frame-Options is dropped rather than kept, because it cannot express an
 * allowlist: ALLOW-FROM is dead in every current browser, so DENY would simply
 * override the narrowed policy. CSP frame-ancestors is the control browsers
 * actually enforce, and it is strictly more expressive.
 *
 * Upstream's own file is never edited, so `git pull` in vendor/ stays clean.
 */
import path from 'node:path';
import base from '../../vendor/gods-eye-view/vite.config.js';

const VENDOR = path.resolve(import.meta.dirname, '../../vendor/gods-eye-view');

/* Origins allowed to frame the app. The shell injects HEADUNIT_SHELL_ORIGIN;
 * the fallbacks cover a shell opened on either loopback name at the default
 * port, since which one the browser uses is the user's choice, not ours. */
const shellOrigins = process.env.HEADUNIT_SHELL_ORIGIN
  ? [process.env.HEADUNIT_SHELL_ORIGIN]
  : ['http://localhost:4100', 'http://127.0.0.1:4100'];

export default async (env) => {
  const config = await base(env);

  // Their config declares no root, so it would otherwise resolve against THIS
  // file's directory instead of the checkout it belongs to.
  config.root = VENDOR;

  config.server = {
    ...config.server,
    headers: {
      ...config.server?.headers,
      'X-Frame-Options': undefined,
      'Content-Security-Policy': `frame-ancestors 'self' ${shellOrigins.join(' ')}`,
    },
  };
  // An undefined value still emits an empty header in some versions; drop the key.
  delete config.server.headers['X-Frame-Options'];

  return config;
};
