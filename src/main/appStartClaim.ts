// The "first renderer load of this app run" signal for SSH hosts with "Łącz ponownie po uruchomieniu aplikacji".
// Only the app window may claim it, once; a Pty Host restart before the claim spends it (D5 applies after a restart).
export interface AppStartClaim {
  /** True for the first claim of the app window in this run, false afterwards and for any other sender (which spends nothing). */
  claim(fromAppWindow: boolean): boolean;
  /** A Pty Host crash or fatal stop: later claims get false. */
  cancel(): void;
}

export function createAppStartClaim(): AppStartClaim {
  let unclaimed = true;
  return {
    claim(fromAppWindow) {
      if (!fromAppWindow) return false;
      const first = unclaimed;
      unclaimed = false;
      return first;
    },
    cancel() { unclaimed = false; },
  };
}
