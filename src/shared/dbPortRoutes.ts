// Which window's DB port gets a DB Host message (1.0.8: database and Redis tabs in their own window). Every window has its own
// port; a result goes to the window that asked for it. Rows, statement ends and notices are keyed by query id: the window that
// sent the query, the table page or the "load more" gets them. Redis Pub/Sub messages are keyed by session: the window that
// subscribed (or the one its tab moved to) gets them. Anything unknown goes to the main window. Pure, so it is tested in Node.
import type { DbPortMessage } from './db';
import type { DbHostOp } from './dbHostIpc';

export const MAIN_DB_WINDOW = 'main';
/** Query routes kept at most (oldest go first; a query that old has long ended). */
export const DB_ROUTE_QUERIES_MAX = 4096;

const isWindow = (w: unknown): w is string => typeof w === 'string' && w.length > 0 && w.length <= 128;

export class DbPortRoutes {
  private queries = new Map<string, string>();
  private sessions = new Map<string, string>();

  constructor(private readonly maxQueries = DB_ROUTE_QUERIES_MAX) {}

  /** An operation from `window` (absent: the main window): its results go back there. */
  noteOp(sessionId: string, op: DbHostOp, window?: string): void {
    const w = isWindow(window) ? window : MAIN_DB_WINDOW;
    const queryId = op.op === 'query' || op.op === 'tablePage' ? op.req.queryId : op.op === 'fetchMore' ? op.queryId : null;
    if (queryId) this.setQuery(queryId, w);
    // Pub/Sub messages name the session only: the window that changes or reads the subscriptions owns them.
    if (op.op === 'redis' && (op.req.kind === 'subscribe' || op.req.kind === 'unsubscribe' || op.req.kind === 'pubsubState')) this.setSession(sessionId, w);
  }

  /** A tab moved to another window: messages of its sessions follow it (`window` null: the main window). */
  moveSessions(ids: readonly string[], window: string | null): void {
    for (const id of ids) this.setSession(id, isWindow(window) ? window : MAIN_DB_WINDOW);
  }

  /** A session ended: its route goes. */
  forgetSession(id: string): void { this.sessions.delete(id); }

  /** The receiving window of a port message. */
  target(m: DbPortMessage): string {
    if ('queryId' in m && typeof m.queryId === 'string') return this.queries.get(m.queryId) ?? MAIN_DB_WINDOW;
    if ('sessionId' in m && typeof m.sessionId === 'string') return this.sessions.get(m.sessionId) ?? MAIN_DB_WINDOW;
    return MAIN_DB_WINDOW;
  }

  private setQuery(queryId: string, window: string): void {
    this.queries.delete(queryId);
    if (window !== MAIN_DB_WINDOW) this.queries.set(queryId, window);
    while (this.queries.size > this.maxQueries) this.queries.delete(this.queries.keys().next().value!);
  }

  private setSession(id: string, window: string): void {
    if (window === MAIN_DB_WINDOW) this.sessions.delete(id); else this.sessions.set(id, window);
  }
}

/** The port a message goes to: its window's, else the main window's (a window that is gone or reloading drops nothing silently into nowhere). */
export function pickPort<P>(ports: ReadonlyMap<string, P>, window: string): P | undefined {
  return ports.get(window) ?? ports.get(MAIN_DB_WINDOW);
}
