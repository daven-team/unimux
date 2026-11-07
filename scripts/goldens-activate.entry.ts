// One entry for scripts/goldens-activate.mjs: activate.ts, swap.ts and store.ts in one module graph (the swap slot and its
// flags are module state of swap.ts).
export * as activate from '../src/main/accounts/activate';
export * as swap from '../src/main/accounts/swap';
export { AccountsStore } from '../src/main/accounts/store';
