// Work that would make one long task (the terminals of a grid that mounts) split into one task per item. Pure apart from the
// injected `post`, so the order and the cancelling are tested without a browser.

/** Runs one callback in a task of its own, after whatever is queued already (MessageChannel in the renderer). */
export type PostTask = (fn: () => void) => void;

interface Job { id: string; run: () => void }

/**
 * A queue run one job per task: `first` jobs go before the others (the focused cell), the rest in the order they were added
 * (the order the cells mounted). A job cancelled before its turn never runs; a job that throws does not stop the queue.
 */
export class StagedQueue {
  private jobs: Job[] = [];
  private posted = false;

  constructor(private readonly post: PostTask) {}

  /** Jobs of this id are waiting. */
  has(id: string): boolean {
    return this.jobs.some((j) => j.id === id);
  }

  get size(): number {
    return this.jobs.length;
  }

  add(id: string, run: () => void, first = false): () => void {
    const job: Job = { id, run };
    if (first) {
      // After the other first jobs, before everything else.
      let at = 0;
      while (at < this.jobs.length && this.firsts.has(this.jobs[at])) at++;
      this.jobs.splice(at, 0, job);
      this.firsts.add(job);
    } else this.jobs.push(job);
    this.pump();
    return () => {
      const at = this.jobs.indexOf(job);
      if (at >= 0) this.jobs.splice(at, 1);
      this.firsts.delete(job);
    };
  }

  private firsts = new WeakSet<Job>();

  private pump(): void {
    if (this.posted || !this.jobs.length) return;
    this.posted = true;
    this.post(() => {
      this.posted = false;
      const job = this.jobs.shift();
      try {
        job?.run();
      } finally {
        this.pump();
      }
    });
  }
}

/**
 * A new task for `fn` without setTimeout's 4 ms clamp after nested calls (MessageChannel); setTimeout where there is none.
 * One channel serves every call, in the order of the calls.
 */
export function messageChannelPost(): PostTask {
  if (typeof MessageChannel !== 'function') return (fn) => { setTimeout(fn, 0); };
  const channel = new MessageChannel();
  const queue: Array<() => void> = [];
  channel.port1.onmessage = () => queue.shift()?.();
  return (fn) => {
    queue.push(fn);
    channel.port2.postMessage(null);
  };
}
