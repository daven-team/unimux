// Messages between main and the conversation search thread (types only).
import type { ConvQuery } from '../shared/convSearch';

export interface ConvWorkerData { claudeRoots: string[]; codexRoots: string[]; cacheFile?: string }

export type ConvWorkerRequest =
  | { t: 'search'; id: number; query: ConvQuery }
  | { t: 'transcript'; id: number; file: string }
  | { t: 'stats'; id: number }
  | { t: 'shutdown'; id: number };

export type ConvWorkerReply = { t: 'reply'; id: number; result?: unknown; error?: string };
