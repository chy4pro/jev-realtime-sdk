# jev-realtime-sdk

Continuous actions driven by TypeSafe Jev. An agent built on a generative model acts in discrete steps, seconds apart; it cannot keep a cursor moving, keep a drone flying or keep a slider dragging while deciding when to stop. Jev answers a typed question in 100 to 300 ms, so it can sit inside a running action and be asked several times a second: keep going, slow down, reverse, stop. This SDK is the loop around that: a fast inner tick owned by code, a slower decision tick owned by Jev, and the contracts between them. Mouse and browser first; drones, robots and games use the same loop with a different observer and actuator.

What "real time" means here: Jev decides at 2 to 10 Hz (network to the provider is the floor; a local decision model would raise it). Anything that must react in milliseconds (collision reflexes, balance, limits) belongs to a code layer beneath Jev, which every working Jev control project has. The SDK makes that split explicit instead of leaving it to each project.

Built on [jev-dev-kit](../jev-dev-kit/). Community project, not affiliated with TypeSafe.

## Status

Design stage. See [DESIGN.md](DESIGN.md) for the structure, distilled from seven Jev control projects (two drones, two robot arms, a real-time game, Mario, Doom).

## License

MIT
