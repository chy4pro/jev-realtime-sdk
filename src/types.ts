import type { Candidate, JevClient, JevState, RunState, StepTrace } from 'jev-dev-kit';

/**
 * A continuous behaviour under Jev's control. Code owns the fast inner tick (observe, apply,
 * reflex, stop); Jev owns the slower decision tick (which verb to hold next). Nothing here is
 * specific to a cursor, a drone or a robot: those differ only in observe and apply.
 */
export interface Controller<S> {
  /** Inner tick: read the world. Cheap and synchronous; called at `innerHz`. */
  observe(): S;
  /** Decision tick: the facts Jev sees. Small, symbolic, computed here (bearings, buckets, flags). Must include `task`. */
  encode(state: S, run: RunState): JevState;
  /** The discrete verbs Jev chooses among, already filtered for safety. Fixed, or derived from the state. */
  verbs: Candidate[] | ((state: S) => Candidate[]);
  /** What Jev should weigh when choosing the next verb. */
  rules: string | Record<string, unknown>;
  /**
   * Inner tick: drive the actuator toward the held verb. `verb` is null before the first
   * decision, while `inFlight: 'zero'` waits, or after a verb expired: treat null as "do nothing"
   * (or decelerate). Smoothing (ramps, slew limits) belongs here.
   */
  apply(verb: string | null, state: S, dtMs: number): void;
  /** Inner tick: the code-owned stop condition. A string is the reason. */
  stop(state: S): boolean | string;
  /** Inner tick: an override that ignores Jev (obstacle, limit). Return a verb to force, or null. */
  reflex?(state: S): string | null;
  /** Identity of what Jev sees between decisions; unchanged means the held verb did nothing. Default: the encoded state. */
  fingerprint?(state: S): string;
}

export type DecideTrigger =
  | { every: number } // every N inner ticks
  | { hz: number } // a fixed rate
  | { onExpiry: number } // when the held verb has been held this many ms
  | { when: (state: unknown, sinceLastDecisionMs: number) => boolean };

export interface RealtimeOptions {
  jev: JevClient;
  model: string;
  /** Inner tick rate (observe, apply, stop, reflex). */
  innerHz: number;
  /** When to ask Jev. At most one decision is in flight; a trigger during one is skipped. */
  decide: DecideTrigger;
  /** What the inner tick does while a decision is in flight: keep the held verb, apply null, or skip apply entirely. */
  inFlight?: 'hold' | 'zero' | 'pause';
  /** An answer arriving later than this is dropped; the in-flight policy stays until the next decision. */
  timeoutMs?: number;
  /** A held verb older than this (no new decision) becomes `defaultVerb`. Off by default. */
  expiryMs?: number;
  /** Below this confidence the decision is replaced by `defaultVerb`. */
  confidenceFloor?: number;
  /** What "unsure", "dropped" and "failed" mean for this actuator. Default null (do nothing). */
  defaultVerb?: string | null;
  /** Stop with an error after this many consecutive decisions that were dropped, failed, or replaced by the default. */
  maxConsecutiveDefaults?: number;
  /** Whether Jev choosing DONE (after the kit's veto and confirmation) ends the run when `stop()` disagrees. Default false: code owns stop. */
  allowJevStop?: boolean;
  /** Budgets. */
  maxDecisions?: number;
  maxMs?: number;
  /** Passed to the kit's Decider (thresholds, limits, fallback, terminal, passive). */
  decider?: { thresholds?: { goalDone?: number; stuck?: number; terminalConfirm?: number }; limits?: { noChangeRun?: number; repeatLimit?: number; repeatWindow?: number; consecutiveErrors?: number }; fallback?: (ctx: { candidates: Candidate[]; reason: string }) => string | null; passive?: string[] };
  onDecision?: (d: DecisionRecord) => void;
  /** Clock for tests. Default: Date.now and setTimeout. */
  clock?: Clock;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface DecisionRecord {
  /** Sequence number of the decision. */
  n: number;
  /** Inner tick at which it was requested, and at which the answer was applied (or dropped). */
  requestedTick: number;
  answeredTick?: number;
  latencyMs?: number;
  /** What happened to the answer. */
  fate: 'applied' | 'dropped_late' | 'dropped_stale' | 'failed' | 'retry' | 'again' | 'default_low_confidence' | 'stop';
  verb?: string | null;
  confidence?: number;
  goalDone?: number;
  stuck?: number;
  note?: string;
  trace?: StepTrace;
}

export interface RealtimeResult {
  status: 'done' | 'blocked' | 'error' | 'stopped';
  reason: string;
  ticks: number;
  decisions: number;
  dropped: number;
  defaults: number;
  elapsedMs: number;
  /** Median and max Jev latency over applied decisions. */
  latencyMs: { median: number | null; max: number | null };
  records: DecisionRecord[];
  history: RunState['history'];
}
