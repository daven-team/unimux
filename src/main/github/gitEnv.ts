// How git gets a GitHub token without it ever being on a command line (where other processes and crash reports can read it):
// one configuration entry passed in the environment (GIT_CONFIG_COUNT, git 2.31+), an HTTP header that git sends to
// https://github.com/ only. No Electron here, so the tests can check it.

/** The configuration key: `http.<url>.extraHeader` applies to that URL prefix only, never to another host. */
export const GITHUB_HEADER_KEY = 'http.https://github.com/.extraheader';

/**
 * The environment additions that make git authenticate to https://github.com with `token`. Tracing is switched off and
 * redaction on (a GIT_TRACE_CURL of the user's environment would print the header), and git never waits for a prompt.
 */
export function githubGitEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: GITHUB_HEADER_KEY,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_TRACE_REDACT: '1',
    GIT_TRACE: '0',
    GIT_TRACE_CURL: '0',
    GIT_TRACE_PACKET: '0',
    GIT_CURL_VERBOSE: '0',
  };
}

/**
 * Did GitHub refuse the credentials of a network operation (so the user's own credential manager may get a try without ours)?
 * Only git's messages about an https://github.com address count.
 */
export function githubAuthRefused(message: string): boolean {
  if (!/https:\/\/(?:[^/\s@]+@)?github\.com\//i.test(message)) return false;
  return /Authentication failed|Invalid username or password|returned error: 40[13]|Permission to .* denied|could not read (?:Username|Password)|terminal prompts disabled|Repository not found/i.test(message);
}
