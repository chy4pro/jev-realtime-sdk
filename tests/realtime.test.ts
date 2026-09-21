import type { JevClient, JevResponse } from 'jev-dev-kit';
import { describe, expect, it, vi } from 'vitest';
import { Realtime, type Clock, type Controller } from '../src/index.js';

/** A manual clock: tests advance time explicitly. */
function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

/** A 1-D cursor moving toward a target; the verbs are what a real cursor controller would offer. */
interface Cursor { x: number; target: number; v: number }
function cursor(start = 0, target = 100): { c: Controller<Cursor>; w: Cursor } {
  const w: Cursor = { x: start, target, v: 0 };
  const facts = (s: Cursor) => ({ side: s.x < s.target - 2 ? 'left' : s.x > s.target + 2 ? 'right' : 'on', distance: Math.abs(s.target - s.x) < 10 ? 'near' : Math.abs(s.target - s.x) < 40 ? 'mid' : 'far', moving: s.v !== 0 });
  const c: Controller<Cursor> = {
    observe: () => ({ ...w }),
    encode: (s) => ({ task: 'move the cursor onto the target', ...facts(s) }),
    verbs: [
      { id: 'toward', description: 'Move toward the target at full speed.' },
      { id: 'slow', description: 'Move toward the target slowly.' },
      { id: 'stop', description: 'Stop moving.' },
      { id: 'back', description: 'Move away from the target.' },
    ],
    rules: 'Bring the cursor onto the target without overshooting.',
    apply: (verb, s, dt) => {
      const dir = Math.sign(s.target - w.x) || 1;
      const speed = verb === 'toward' ? 100 : verb === 'slow' ? 20 : verb === 'back' ? -50 : 0; // units per second
      w.v = speed * dir;
      w.x += (w.v * dt) / 1000;
    },
    stop: (s) => (Math.abs(s.x - s.target) <= 2 ? 'cursor is on the target' : false),
    fingerprint: (s) => JSON.stringify(facts(s)),
  };
  return { c, w };
}

// `conf` is the reported confidence, which the kit records verbatim; the probability
// distribution is a separate thing it validates strictly (the choice must be the argmax, or
// within its rounding tolerance). A low-confidence pick is still a valid distribution — e.g.
// 0.55 vs 0.45 — so keep the chosen candidate's share at least that high regardless of `conf`.
const answer = (choice: string, conf = 0.9, goal = 0.05): JevResponse => {
  const share = Math.max(conf, 0.55);
  const other = choice === 'BLOCKED' ? 'DONE' : 'BLOCKED';
  return {
    model: 'm',
    answers: { action: { choice, confidence: conf, probabilities: { [choice]: share, [other]: 1 - share } }, goal_done: { probability: goal }, stuck: { probability: 0.1 } },
  };
};

/** A scripted "Jev" that reads the facts it is sent and answers as a sensible policy would, after `latency`. */
function policyJev(clock: ReturnType<typeof fakeClock>, latency = 100): JevClient & { calls: number } {
  const fn = (async (req: any) => {
    fn.calls++;
    clock.advance(latency);
    const s = req.state as { side: string; distance: string };
    if (s.side === 'on') return answer('stop');
    if (s.distance === 'near') return answer('slow');
    return answer('toward');
  }) as JevClient & { calls: number };
  fn.calls = 0;
  return fn;
}

/** Runs ticks with the manual clock until the run ends or `max` ticks. Lets in-flight promises settle between ticks. */
async function drive<S>(rt: Realtime<S>, clock: ReturnType<typeof fakeClock>, periodMs: number, max = 500) {
  for (let i = 0; i < max && !rt.done; i++) {
    rt.tick();
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(periodMs);
  }
  await rt.settle();
  return rt.done ?? rt.tick()!;
}

describe('Realtime', () => {
  it('holds the verb Jev chose between decisions, keeps moving while a decision is in flight, and stops when code says so', async () => {
    const clock = fakeClock();
    const { c, w } = cursor(0, 100);
    const jev = policyJev(clock, 0);
    const rt = new Realtime(c, { jev, model: 'm', innerHz: 50, decide: { every: 10 }, clock });
    const r = await drive(rt, clock, 20);

    expect(r.status).toBe('done');
    expect(r.reason).toBe('cursor is on the target');
    expect(Math.abs(w.x - 100)).toBeLessThanOrEqual(2);
    expect(r.decisions).toBeGreaterThan(1);
    expect(r.decisions).toBeLessThan(r.ticks); // far fewer decisions than ticks
    const verbs = r.records.map((d) => d.verb);
    expect(verbs[0]).toBe('toward');
    expect(verbs).toContain('slow');
    expect(r.history.map((h) => h.id)).toEqual(r.records.filter((d) => d.fate === 'applied').map((d) => d.verb));
    expect(r.history[0].outcome).toBe('state changed'); // the kit settled the outcome from the fingerprint
  });

  it('drops an answer that arrives after timeoutMs and keeps the held verb; a run of drops trips the breaker', async () => {
    const clock = fakeClock();
    const { c } = cursor(0, 1000);
    const jev = policyJev(clock, 500); // always late
    const rt = new Realtime(c, { jev, model: 'm', innerHz: 50, decide: { hz: 2 }, timeoutMs: 300, maxConsecutiveDefaults: 3, clock });
    const r = await drive(rt, clock, 20);
    expect(r.status).toBe('error');
    expect(r.reason).toMatch(/3 consecutive decisions were dropped/);
    expect(r.records.every((d) => d.fate === 'dropped_late')).toBe(true);
    expect(r.dropped).toBe(3);
  });

  it('applies null while waiting under inFlight: "zero", and nothing at all under "pause"', async () => {
    for (const mode of ['zero', 'pause'] as const) {
      const clock = fakeClock();
      const { c } = cursor(0, 1000);
      const applied: Array<string | null> = [];
      const orig = c.apply;
      c.apply = (v, s, dt) => { applied.push(v); orig(v, s, dt); };
      const jev = policyJev(clock, 0);
      const slowJev: JevClient = (req) => new Promise((res) => setTimeout(() => res(jev(req)), 0)); // answers after the tick
      const rt = new Realtime(c, { jev: slowJev, model: 'm', innerHz: 50, decide: { every: 5 }, inFlight: mode, maxDecisions: 2, clock });
      rt.tick(); // decision 1 requested, in flight during this tick
      if (mode === 'zero') expect(applied).toEqual([null]);
      else expect(applied).toEqual([]);
      await new Promise((r) => setTimeout(r, 5));
      await rt.settle();
      applied.length = 0;
      rt.tick();
      expect(applied).toEqual(['toward']); // answer applied, held on the next tick
    }
  });

  it('a reflex overrides the held verb on the inner tick without asking Jev', async () => {
    const clock = fakeClock();
    const { c, w } = cursor(0, 100);
    c.reflex = (s) => (s.x > 60 ? 'stop' : null);
    c.stop = (s) => (s.x > 60 && s.v === 0 ? 'held by reflex' : false);
    const jev = policyJev(clock, 0);
    const rt = new Realtime(c, { jev, model: 'm', innerHz: 50, decide: { every: 100 }, clock });
    const r = await drive(rt, clock, 20);
    expect(r.status).toBe('done');
    expect(r.reason).toBe('held by reflex');
    expect(w.x).toBeGreaterThan(60);
    expect(jev.calls).toBe(1);
  });

  it('a held verb expires to the default; low confidence takes the default; Jev DONE does not end the run unless allowed', async () => {
    const clock = fakeClock();
    const { c, w } = cursor(0, 1000);
    const jev = vi.fn<JevClient>()
      .mockImplementationOnce(async () => answer('toward', 0.9))
      .mockImplementationOnce(async () => answer('toward', 0.1))
      .mockImplementationOnce(async () => answer('DONE', 0.9, 0.9))
      .mockImplementation(async () => answer('toward', 0.9));
    const rt = new Realtime(c, { jev, model: 'm', innerHz: 50, decide: { hz: 5 }, expiryMs: 100, confidenceFloor: 0.3, defaultVerb: 'stop', maxDecisions: 3, clock });
    const r = await drive(rt, clock, 20);
    expect(r.status).toBe('blocked');
    expect(r.reason).toMatch(/3-decision budget/);
    expect(r.records.map((d) => d.fate)).toEqual(['applied', 'default_low_confidence', 'stop']);
    expect(r.records[2].note).toMatch(/code did not confirm/);
    expect(w.x).toBeLessThan(60); // it stopped moving after the low-confidence decision and the vetoed DONE
    expect(r.defaults).toBe(2);
  });

  it('Jev DONE ends the run when allowJevStop is set', async () => {
    const clock = fakeClock();
    const { c } = cursor(0, 1000);
    const jev: JevClient = async () => answer('DONE', 0.9, 0.95);
    const rt = new Realtime(c, { jev, model: 'm', innerHz: 50, decide: { every: 5 }, allowJevStop: true, clock });
    const r = await drive(rt, clock, 20);
    expect(r.status).toBe('done');
    expect(r.reason).toBe('Jev reported the task complete.');
  });

  it('a stale run of no-change decisions ends as blocked through the kit', async () => {
    const clock = fakeClock();
    const { c } = cursor(0, 1000);
    c.apply = () => undefined; // the actuator is broken: nothing ever moves
    const jev: JevClient = async () => answer('toward');
    const rt = new Realtime(c, { jev, model: 'm', innerHz: 50, decide: { every: 5 }, clock });
    const r = await drive(rt, clock, 20);
    expect(r.status).toBe('blocked');
    expect(r.reason).toMatch(/no change/);
  });
});
