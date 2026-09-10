/*
 * Keeping secrets out of output.
 *
 * This matters more here than it looks. The shell's supervisor pipes each app's
 * stdout and stderr into a ring buffer, and the Settings screen renders that
 * buffer on the dashboard — so a token in a log line is a token on the
 * windscreen. The riskiest path is a FAILED sign-in, where an upstream error
 * message may quote back the credential it rejected.
 */

const looksLikeCredential = /\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi;

export function createRedactor() {
  const secrets = new Set();

  return {
    /** Register a string that must never appear in output. */
    guard(value) {
      if (typeof value === 'string' && value.length >= 8) secrets.add(value);
      return value;
    },

    /** Stop guarding one — used for a password once the request is done. */
    release(value) { secrets.delete(value); },

    redact(text) {
      let out = String(text);
      for (const secret of secrets) out = out.split(secret).join('[redacted]');
      // Belt and braces, for a credential that was never registered because it
      // arrived inside somebody else's error message.
      return out.replace(looksLikeCredential, '$1 [redacted]');
    },
  };
}
