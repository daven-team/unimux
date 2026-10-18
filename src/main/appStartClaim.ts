// The "first renderer load of this app run" signal for SSH hosts with "Łącz ponownie po uruchomieniu aplikacji".
// Claimed once (the IPC channel is sender-guarded, so only the app window gets here); a Pty Host restart before the claim
// spends it (D5 applies after a restart).
export interface AppStartClaim {
  /** True for the first claim in this run, false afterwards. */
  claim(): boolean;
  /** A Pty Host crash or fatal stop: later claims get false. */
  cancel(): void;
}

export function createAppStartClaim(): AppStartClaim {
  let unclaimed = true;
  return {
    claim() {
      const first = unclaimed;
      unclaimed = false;
      return first;
    },
    cancel() { unclaimed = false; },
  };
}
