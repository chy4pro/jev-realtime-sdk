# Design

## Where this comes from

Seven projects put Jev inside a running control loop (RomanSlack/jev-drone, kxzk/typesafe-jev-drone-demo, openroboto-ai/jev-robot-control, FazalAAli/jev-robotics-demo, Icohen007/jev-play-ping-pong, fhshaik/typesafe-mario, lukaske/jev-doom-agent). None share code; all share the same structure. Measured: 110 ms median per decision on TypeSafe direct (21 decisions/s pipelined), 325 ms median via a gateway with 0 late actions over 124 decisions in the table-tennis game.

The recurring structure:

1. Two ticks. An inner loop (physics, render, poll, cursor motion) runs at 15 to 500 Hz in code. Jev is asked on a separate, slower tick: a fixed period, every N inner ticks, an event (something is approaching), or when the current command expires. Nobody asks Jev every frame.
2. The action in flight is held while Jev thinks (one project decays to zero after a timeout; that is a policy, not an accident).
3. State is small, symbolic and computed in code: bearings, distance buckets, boolean facts, "will overshoot at this speed". No project sends pixels or uses a vision model in the loop.
4. Candidates are a small discrete set of verbs (6 to 9), enumerated and safety-filtered in code before Jev sees them.
5. A smoothing layer sits between Jev's discrete pick and the actuator: slew limits, exponential blend, ramps. Jev never emits a continuous signal.
6. "Stop" is a code check in most projects; a Noul can be layered on it but does not replace it.
7. A dead-man policy exists everywhere and is never "quietly switch to a script": hold, decay, pause, fall back to a declared default, or fail loudly.
8. Latency is absorbed (cadence, expiry windows, async caching), not predicted.

## The contract

```ts
interface Controller<S> {
  observe(): S;                                   // inner tick: read the world (cheap, synchronous)
  encode(state: S, run: RunState): JevState;      // decision tick: the facts Jev sees
  verbs: Candidate[] | ((state: S) => Candidate[]); // the discrete actions, pre-filtered for safety
  rules: string | Record<string, unknown>;
  apply(verb: string | null, state: S, dt: number): void; // inner tick: drive the actuator toward the verb (with smoothing)
  stop(state: S): boolean | string;               // code-owned stop condition (true / reason)
  reflex?(state: S): string | null;               // inner-tick override that ignores Jev (obstacle, limit)
}

interface RealtimeOptions {
  jev: JevClient; model: string;
  innerHz: number;                                 // e.g. 60
  decide: { every: number } | { hz: number } | { onExpiry: number } | { when: (s) => boolean };
  inFlight: 'hold' | 'zero' | 'pause';
  timeoutMs: number;                               // a late answer is dropped, inFlight policy applies
  confidenceFloor?: number;                        // below it: the declared default verb
  defaultVerb?: string;                            // what "unsure" and "error" mean for this actuator
  maxConsecutiveDefaults?: number;                 // circuit breaker
  stopNoul?: boolean;                              // also ask "should this stop now?" and require agreement
  onDecision?: (trace) => void;
}
```

`runRealtime(controller, options)` owns both ticks: it calls `observe` and `apply` at `innerHz`, asks Jev on the decision tick with the current verbs plus the standing `stop` noul, validates the answer with jev-dev-kit, and applies the in-flight and dead-man policies. It returns when `stop` says so, on the circuit breaker, or on a budget. The trace is jev-dev-kit's, plus the timing of every decision relative to the inner tick.

## First actuator: the cursor

Observer: element rects and the cursor position from the page (the extension's snapshot, or CDP). Facts: target bearing (left/right/up/down/on), distance bucket, speed, "would overshoot next tick". Verbs: `toward`, `slow`, `stop`, `back`. Apply: CDP `mouseMoved` at inner-tick rate with a velocity ramp. Stop: cursor inside the target rect for one tick. Use cases: move onto an element without a coordinate, scroll until a heading appears, drag a slider until the value reads right, hold a key until a state is reached.

## Later actuators

Simulated drone (MuJoCo or a browser sim) and a robot arm, to show the loop is the same; both come from the surveyed projects' observation formats.

## What comes from jev-dev-kit, and what does not

Used as is: the `JevClient` function type (any provider, or a local model), the `Candidate` contract, `validateChoiceAnswer` and `readNoul`, the trace format, and the two controls (`shufflingClient`, `keywordClient`).

Not used: `runLoop`. It is observe → ask → act with the step waiting on Jev; a real-time loop keeps applying the held verb on the inner tick while the answer is in flight, and may drop a late answer. `runRealtime` is therefore a second runtime built from the kit's parts, not a wrapper around the first. If the two runtimes turn out to share enough (validation, veto, circuit breaker, trace), that common core moves into the kit later.

## Evaluation

Every actuator ships a scenario set with code-verified outcomes and the two controls from the kit (shuffled candidates, keyword baseline), plus timing: decisions per second, late answers, time to stop.
