import { Decider, type Candidate, type Chosen, type Prepared } from 'jev-dev-kit';
import type { Clock, Controller, DecisionRecord, RealtimeOptions, RealtimeResult } from './types.js';

const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * The two-tick runtime as a state machine. `tick()` advances one inner tick; `run()` drives it
 * with the clock. Decisions are asynchronous: at most one in flight, the inner tick never waits
 * for it, and an answer that arrives after `timeoutMs` or after a newer decision was requested is
 * dropped. Everything about a decision itself (request, validation, veto, repetition, history)
 * is the kit's Decider.
 */
export class Realtime<S> {
  readonly records: DecisionRecord[] = [];
  private readonly decider: Decider<S>;
  private readonly clock: Clock;
  private readonly startedAt: number;
  private tickNo = 0;
  private lastTick: number;
  private verb: string | null;
  private verbSince: number;
  private lastDecisionAt: number;
  private inFlight: { n: number; requestedTick: number; requestedAt: number } | null = null;
  private decisionsMade = 0;
  private dropped = 0;
  private defaults = 0;
  private consecutiveDefaults = 0;
  private result: RealtimeResult | null = null;
  private pendingResolve: (() => void) | null = null;

  constructor(private readonly c: Controller<S>, private readonly o: RealtimeOptions) {
    this.clock = o.clock ?? realClock;
    this.startedAt = this.clock.now();
    this.lastTick = this.startedAt;
    this.verb = o.defaultVerb ?? null;
    this.verbSince = this.startedAt;
    this.lastDecisionAt = -Infinity;
    const verbs = c.verbs;
    this.decider = new Decider<S>(
      {
        encode: (s, run) => c.encode(s, run),
        decisions: { action: { kind: 'choice', ...(typeof verbs === 'function' ? { options: verbs } : { fixed: verbs }), rules: c.rules } },
        fingerprint: c.fingerprint ? (s) => c.fingerprint!(s) : undefined,
      },
      {
        model: o.model,
        ...(o.decider || {}),
        // Continuous control holds the same verb across many consecutive decisions on purpose
        // (steering "toward" a target does not change until the target does); the kit's default
        // repeatLimit (3 within a 6-decision window) is tuned for a discrete action loop where
        // repeating an action is normally a sign of being stuck. Realtime disables it by default
        // — a caller can still opt back in via `options.decider.limits.repeatLimit`. noChangeRun
        // stays a real deadlock signal (the fingerprint is code-chosen facts, not the raw state,
        // so it can legitimately stay constant for a tick or two while the cursor is mid-bucket)
        // but gets a slightly larger default so normal bucket-dwell time doesn't trip it early.
        limits: { repeatLimit: Number.POSITIVE_INFINITY, noChangeRun: 5, ...(o.decider?.limits || {}) },
      }
    );
  }

  get done(): RealtimeResult | null {
    return this.result;
  }

  /** One inner tick. Returns the result once the run has ended. */
  tick(): RealtimeResult | null {
    if (this.result) return this.result;
    const now = this.clock.now();
    const dt = this.tickNo === 0 ? 1000 / this.o.innerHz : now - this.lastTick;
    this.lastTick = now;
    this.tickNo++;

    const state = this.c.observe();

    // Code-owned stop, budgets.
    const stop = this.c.stop(state);
    if (stop) return this.finish('done', typeof stop === 'string' ? stop : 'Stop condition met.');
    if (this.o.maxMs !== undefined && now - this.startedAt >= this.o.maxMs) return this.finish('blocked', `Reached the ${this.o.maxMs} ms budget.`);
    if (this.o.maxDecisions !== undefined && this.decisionsMade >= this.o.maxDecisions && !this.inFlight) return this.finish('blocked', `Reached the ${this.o.maxDecisions}-decision budget.`);

    // Expiry of the held verb.
    if (this.o.expiryMs !== undefined && this.verb !== null && now - this.verbSince >= this.o.expiryMs && !this.inFlight) {
      this.verb = this.o.defaultVerb ?? null;
      this.verbSince = now;
    }

    // Decision tick.
    if (!this.inFlight && this.shouldDecide(state, now)) this.startDecision(state, now);

    // Apply: reflex first, then the held verb under the in-flight policy.
    const reflex = this.c.reflex?.(state) ?? null;
    if (reflex !== null) this.safeApply(reflex, state, dt);
    else if (!this.inFlight) this.safeApply(this.verb, state, dt);
    else if ((this.o.inFlight ?? 'hold') === 'hold') this.safeApply(this.verb, state, dt);
    else if (this.o.inFlight === 'zero') this.safeApply(null, state, dt);
    // 'pause': apply nothing while waiting
    return this.result;
  }

  /** Runs inner ticks on the clock until the run ends. */
  async run(): Promise<RealtimeResult> {
    const period = 1000 / this.o.innerHz;
    while (!this.result) {
      const before = this.clock.now();
      this.tick();
      if (this.result) break;
      const spent = this.clock.now() - before;
      await this.clock.sleep(Math.max(0, period - spent));
    }
    return this.result!;
  }

  /** Resolves when no decision is in flight (tests, orderly shutdown). */
  settle(): Promise<void> {
    if (!this.inFlight) return Promise.resolve();
    return new Promise((r) => { this.pendingResolve = r; });
  }

  private shouldDecide(state: S, now: number): boolean {
    const since = now - this.lastDecisionAt;
    const d = this.o.decide;
    if ('every' in d) return this.tickNo === 1 || this.tickNo % d.every === 0;
    if ('hz' in d) return since >= 1000 / d.hz;
    if ('onExpiry' in d) return this.lastDecisionAt === -Infinity || now - this.verbSince >= d.onExpiry;
    return d.when(state, since);
  }

  private startDecision(state: S, now: number): void {
    const n = ++this.decisionsMade;
    this.lastDecisionAt = now;
    const flight = { n, requestedTick: this.tickNo, requestedAt: now };
    this.inFlight = flight;
    const stall = this.decider.observe(state);
    if (stall) { this.inFlight = null; this.finish(stall.status, stall.reason); return; }
    void (async () => {
      let prepared: Prepared | null = null;
      let record: DecisionRecord = { n, requestedTick: flight.requestedTick, fate: 'failed' };
      try {
        prepared = await this.decider.prepare(state);
        const response = await this.o.jev(prepared.request);
        const arrived = this.clock.now();
        const latencyMs = arrived - flight.requestedAt;
        record = { n, requestedTick: flight.requestedTick, answeredTick: this.tickNo, latencyMs, fate: 'applied' };
        if (this.result) { record.fate = 'dropped_stale'; record.note = 'run already ended'; }
        else if (this.inFlight !== flight) { record.fate = 'dropped_stale'; record.note = 'a newer decision superseded it'; }
        else if (this.o.timeoutMs !== undefined && latencyMs > this.o.timeoutMs) { record.fate = 'dropped_late'; this.dropped++; this.noteDefault(); }
        else this.settleAnswer(response, prepared, latencyMs, record);
      } catch (err: any) {
        record.fate = 'failed';
        record.note = err?.message || String(err);
        this.dropped++;
        this.noteDefault();
      } finally {
        if (this.inFlight === flight) this.inFlight = null;
        this.records.push(record);
        this.o.onDecision?.(record);
        if (!this.inFlight && this.pendingResolve) { const r = this.pendingResolve; this.pendingResolve = null; r(); }
      }
    })();
  }

  private settleAnswer(response: Awaited<ReturnType<RealtimeOptions['jev']>>, prepared: Prepared, latencyMs: number, record: DecisionRecord): void {
    const accepted = this.decider.accept(response, prepared, latencyMs);
    record.trace = accepted.step;
    if (accepted.kind === 'retry' || accepted.kind === 'again') {
      // The kit set a notice; the next decision tick asks again. The held verb stays.
      record.fate = accepted.kind;
      record.note = accepted.step.note;
      this.consecutiveDefaults = 0;
      return;
    }
    if (accepted.kind === 'stop') {
      record.fate = 'stop';
      record.note = accepted.stop.reason;
      if (accepted.stop.status === 'done' && !this.o.allowJevStop) {
        // Jev says DONE but code owns stop: hold the default until stop() agrees.
        this.setVerb(this.o.defaultVerb ?? null);
        record.note = `Jev chose DONE; code did not confirm, holding ${String(this.o.defaultVerb ?? null)}`;
        this.noteDefault();
        return;
      }
      this.finish(accepted.stop.status, accepted.stop.reason);
      return;
    }
    const chosen: Chosen = accepted.chosen;
    record.confidence = chosen.confidence;
    record.goalDone = accepted.step.goalDone;
    record.stuck = accepted.step.stuck;
    if (this.o.confidenceFloor !== undefined && chosen.confidence < this.o.confidenceFloor) {
      record.fate = 'default_low_confidence';
      record.verb = this.o.defaultVerb ?? null;
      this.setVerb(this.o.defaultVerb ?? null);
      // No `note`: let the kit settle the outcome from the fingerprint diff, same as a normal
      // decision. What actually happened (nothing, if the default verb is inert) is truer than a
      // fixed label, and the "why" is already on the record via `fate`.
      this.decider.record(chosen, {}, accepted.step);
      this.noteDefault();
      return;
    }
    record.verb = chosen.id;
    this.setVerb(chosen.id);
    this.consecutiveDefaults = 0;
    // No `note` here either: the kit derives "state changed" / "no visible change" from the
    // fingerprint on the next `observe()`, which is what the no-change deadlock check relies on.
    const stop = this.decider.record(chosen, {}, accepted.step);
    if (stop) this.finish(stop.status, stop.reason);
  }

  private setVerb(verb: string | null): void {
    this.verb = verb;
    this.verbSince = this.clock.now();
  }

  private noteDefault(): void {
    this.defaults++;
    this.consecutiveDefaults++;
    const max = this.o.maxConsecutiveDefaults ?? 5;
    if (this.consecutiveDefaults >= max) this.finish('error', `${this.consecutiveDefaults} consecutive decisions were dropped, failed or replaced by the default.`);
  }

  private safeApply(verb: string | null, state: S, dt: number): void {
    try {
      this.c.apply(verb, state, dt);
    } catch (err: any) {
      this.finish('error', `apply failed: ${err?.message || String(err)}`);
    }
  }

  private finish(status: RealtimeResult['status'], reason: string): RealtimeResult {
    if (this.result) return this.result;
    const lat = this.records.filter((r) => r.fate === 'applied' && r.latencyMs !== undefined).map((r) => r.latencyMs!).sort((a, b) => a - b);
    this.result = {
      status, reason, ticks: this.tickNo, decisions: this.decisionsMade, dropped: this.dropped, defaults: this.defaults,
      elapsedMs: this.clock.now() - this.startedAt,
      latencyMs: { median: lat.length ? lat[Math.floor(lat.length / 2)] : null, max: lat.length ? lat[lat.length - 1] : null },
      records: this.records, history: this.decider.run.history,
    };
    try { this.c.apply(this.o.defaultVerb ?? null, this.c.observe(), 0); } catch { /* actuator already gone */ }
    return this.result;
  }
}

/** Runs a controller to completion on the real clock. */
export function runRealtime<S>(controller: Controller<S>, options: RealtimeOptions): Promise<RealtimeResult> {
  return new Realtime(controller, options).run();
}

export type { Candidate };
