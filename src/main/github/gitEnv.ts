// How git gets a GitHub token without it ever being on a command line (where other processes and crash reports can read it):
// configuration entries passed in the environment (GIT_CONFIG_COUNT, git 2.31+), an HTTP header that git sends to
// https://github.com/ only. No Electron here, so the tests can check it.

export const GITHUB_ORIGIN = 'https://github.com';
/** The configuration key: `http.<url>.extraHeader` applies to that URL prefix only, never to another host. */
export const GITHUB_HEADER_KEY = `http.${GITHUB_ORIGIN}/.extraheader`;
/** The user's credential helpers for github.com (an empty value empties the list git collected from its config files). */
export const GITHUB_HELPER_KEY = `credential.${GITHUB_ORIGIN}.helper`;

/**
 * The environment additions that make git authenticate to https://github.com with `token`. Tracing is switched off and
 * redaction on (a GIT_TRACE_CURL of the user's environment would print the header), and git never waits for a prompt.
 *
 * The user's credential helpers are switched off for github.com in the same run: when GitHub refuses the token (401) git asks
 * the helper for a credential and retries, but curl keeps sending our header instead of it, so the second 401 makes git tell
 * the helper to erase that credential although it was never tried. Without a helper git stops at once ("could not read
 * Username"), and Git.network() runs the command again without our header, with the user's helpers.
 * `origin` is for the tests only (a local server).
 */
export function githubGitEnv(token: string, origin = GITHUB_ORIGIN): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: `credential.${origin}.helper`,
    GIT_CONFIG_VALUE_1: '',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_TRACE_REDACT: '1',
    GIT_TRACE: '0',
    GIT_TRACE_CURL: '0',
    GIT_TRACE_PACKET: '0',
    GIT_CURL_VERBOSE: '0',
  };
}

/** git names an https://github.com address in the message (git leaves the path out of "could not read Username for '…'"). */
const GITHUB_ADDRESS = /https:\/\/(?:[^/\s@'"]+@)?github\.com(?![\w.-])/i;

/** GitHub refused a push that adds or changes .github/workflows files because the token has no "workflow" permission. */
export const workflowScopeRefused = (message: string): boolean => /refusing to allow an? [\w ]*App to create or update workflow|without [`'"]?workflow[`'"]? scope/i.test(message);

/**
 * Did GitHub refuse the credentials of a network operation (so the user's own credential manager may get a try without ours)?
 * Only git's messages about an https://github.com address count. A push refused for a workflow file counts too: the token of
 * unimux's sign-in may lack the "workflow" permission that the user's own credentials have.
 */
export function githubAuthRefused(message: string): boolean {
  if (!GITHUB_ADDRESS.test(message)) return false;
  return workflowScopeRefused(message)
    || /Authentication failed|Invalid username or (?:password|token)|returned error: 40[13]|Permission to .* denied|could not read (?:Username|Password)|terminal prompts disabled|Repository not found/i.test(message);
}

/**
 * Did GitHub answer 401, i.e. it no longer accepts the token at all (revoked, expired, rotated out), rather than refusing it
 * this one repository? With our header and no credential helper, git stops at the prompt it is not allowed to show.
 */
export function githubTokenRefused(message: string): boolean {
  if (!GITHUB_ADDRESS.test(message)) return false;
  return /Authentication failed|Invalid username or (?:password|token)|could not read (?:Username|Password)|terminal prompts disabled/i.test(message);
}
