# jev-realtime-sdk

Continuous actions driven by TypeSafe Jev. An agent built on a generative model acts in discrete steps, seconds apart; it cannot keep a cursor moving, keep a drone flying or keep a slider dragging while deciding when to stop. Jev answers a typed question in 100 to 300 ms, so it can sit inside a running action and be asked several times a second: keep going, slow down, reverse, stop. This SDK is the loop around that: a fast inner tick owned by code, a slower decision tick owned by Jev, and the contracts between them. Mouse and browser first; drones, robots and games use the same loop with a different observer and actuator.

What "real time" means here: Jev decides at 2 to 10 Hz (network to the provider is the floor; a local decision model would raise it). Anything that must react in milliseconds (collision reflexes, balance, limits) belongs to a code layer beneath Jev, which every working Jev control project has. The SDK makes that split explicit instead of leaving it to each project.

Built on [jev-dev-kit](../jev-dev-kit/). Community project, not affiliated with TypeSafe.

## Install

```bash
npm install github:chy4pro/jev-realtime-sdk#v0.1.0
```

Node 20+, TypeScript types included. Not on npm yet.

## The contract

```ts
interface Controller<S> {
  observe(): S;                                     // inner tick: read the world (cheap, synchronous)
  encode(state: S, run: RunState): JevState;         // decision tick: the facts Jev sees (small, symbolic; must include `task`)
  verbs: Candidate[] | ((state: S) => Candidate[]);  // the discrete actions, fixed or derived, pre-filtered for safety
  rules: string | Record<string, unknown>;           // what Jev should weigh when choosing the next verb
  apply(verb: string | null, state: S, dtMs: number): void; // inner tick: drive the actuator toward the held verb, with smoothing
  stop(state: S): boolean | string;                  // inner tick: code-owned stop condition; a string is the reason
  reflex?(state: S): string | null;                  // inner tick: override that ignores Jev (obstacle, limit); return a verb to force, or null
  fingerprint?(state: S): string;                    // identity of what Jev sees between decisions; default is the encoded state
}
```

A complete, runnable example: a 1-D cursor moving toward a target, the same controller the test suite uses.

```ts
import { runRealtime, type Controller, type JevClient } from 'jev-realtime-sdk';

// Any function that answers a Jev request. Here: OpenRouter's Decisions API in one fetch.
const jev: JevClient = async (request) => {
  const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  return res.json();
};

interface Cursor { x: number; target: number; v: number }

const w: Cursor = { x: 0, target: 100, v: 0 };
const facts = (s: Cursor) => ({
  side: s.x < s.target - 2 ? 'left' : s.x > s.target + 2 ? 'right' : 'on',
  distance: Math.abs(s.target - s.x) < 10 ? 'near' : Math.abs(s.target - s.x) < 40 ? 'mid' : 'far',
  moving: s.v !== 0,
});

const controller: Controller<Cursor> = {
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

const result = await runRealtime(controller, {
  jev,
  model: 'typesafe/jev-1.13',
  innerHz: 50,
  decide: { hz: 4 },
  timeoutMs: 400,
  defaultVerb: 'stop',
});
console.log(result.status, result.reason, result.decisions, result.latencyMs);
```

## What the runtime does

**Inner tick**, at `innerHz`: observe the world, check the code-owned `stop` condition, apply verb expiry (a held verb older than `expiryMs` becomes `defaultVerb`), check whether the decision trigger fires, then apply — a `reflex` wins outright and skips Jev for that tick; otherwise the held verb is applied under the in-flight policy (`hold` keeps it, `zero` applies null, `pause` applies nothing while a decision is outstanding).

**Decision tick**, asynchronous: at most one decision is in flight at a time; a trigger that fires while one is outstanding is skipped. The request, validation, veto of an unsupported terminal, confirmation of a hesitant one, repetition limit and cross-decision memory are all jev-dev-kit's `Decider` — the runtime only schedules it differently from the kit's own `runLoop`. An answer that arrives after `timeoutMs`, or after a newer decision has superseded it, is dropped and the in-flight policy stays in force. A confidence below `confidenceFloor` is replaced by `defaultVerb`. Jev choosing DONE only ends the run when `allowJevStop` is set; otherwise code holds `defaultVerb` and waits for its own `stop()` to agree. A run of `maxConsecutiveDefaults` consecutive dropped, failed or defaulted decisions trips a breaker and ends the run with an error. `maxDecisions` and `maxMs` are hard budgets.

## Options

| Option | Default | Meaning |
|---|---|---|
| `jev` | — | The `JevClient` function that answers a Jev request. |
| `model` | — | The Jev model id, e.g. `typesafe/jev-1.13`. |
| `innerHz` | — | Inner tick rate: how often `observe`, `apply`, `stop` and `reflex` run. |
| `decide` | — | When to ask Jev: `{ every }` inner ticks, `{ hz }` a fixed rate, `{ onExpiry }` when the held verb has aged this many ms, or `{ when }` a predicate. |
| `inFlight` | `'hold'` | What the inner tick does while a decision is outstanding: keep the held verb, apply null, or skip apply entirely. |
| `timeoutMs` | none | An answer slower than this is dropped; the in-flight policy stays until the next decision. |
| `expiryMs` | none (off) | A held verb older than this with no new decision becomes `defaultVerb`. |
| `confidenceFloor` | none | Below this confidence, the decision is replaced by `defaultVerb`. |
| `defaultVerb` | `null` | What "unsure", "dropped" and "failed" mean for this actuator. |
| `maxConsecutiveDefaults` | `5` | Circuit breaker: consecutive dropped/failed/defaulted decisions before the run ends with an error. |
| `allowJevStop` | `false` | Whether Jev choosing DONE (after the kit's veto and confirmation) can end the run when code's `stop()` disagrees. |
| `maxDecisions` | none | Budget: stop once this many decisions have been made. |
| `maxMs` | none | Budget: stop once this much time has elapsed. |
| `decider` | see note | Passed through to the kit's `Decider`: thresholds, limits, fallback, terminal and passive candidates. Realtime defaults differ from the kit's: `repeatLimit` is off (holding the same verb across decisions is normal here) and `noChangeRun` is 5 (bucketed facts can stay equal for a couple of decisions while the actuator moves). Your `limits` override both. |
| `onDecision` | none | Called with each `DecisionRecord` as it settles. |
| `clock` | real clock | `{ now, sleep }`; overridden in tests for a manual clock. |

## Result

`RealtimeResult`:

| Field | Meaning |
|---|---|
| `status` | `'done'`, `'blocked'`, `'error'`, or `'stopped'`. |
| `reason` | Why the run ended. |
| `ticks` | Number of inner ticks run. |
| `decisions` | Number of decisions requested. |
| `dropped` | Decisions dropped late or failed. |
| `defaults` | Decisions that resolved to `defaultVerb` (dropped, failed, low confidence, or vetoed DONE). |
| `elapsedMs` | Wall-clock (or simulated) time elapsed. |
| `latencyMs` | Median and max Jev latency, over applied decisions only. |
| `records` | Every `DecisionRecord`, in order. |
| `history` | The kit's `RunState['history']`. |

Each `DecisionRecord` has a `fate`: `'applied'`, `'dropped_late'` (answer arrived after `timeoutMs`), `'dropped_stale'` (superseded by a newer decision, or the run already ended), `'failed'` (the request threw), `'retry'` or `'again'` (the kit asked once more), `'default_low_confidence'`, or `'stop'` (a terminal choice, applied or vetoed).

## Where this comes from

The two-tick structure — an inner loop in code, a slower decision tick for Jev, held actions, symbolic state, safety-filtered candidates and an explicit dead-man policy — is distilled from seven Jev control projects (two drones, two robot arms, a real-time game, Mario, Doom). See [DESIGN.md](DESIGN.md) for the survey and the reasoning behind each part of the contract.

## Status

0.1.0: the runtime and its contract, tested on a simulated actuator with a manual clock; no real actuator yet; the first, a browser cursor over CDP, is next.

## License

MIT
