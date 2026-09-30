# Vendored pi-goal runtime

This directory carries the MIT licensed runtime from `@narumitw/pi-goal@0.54.8`.
`UPSTREAM.json` records the published package, repository, integrity, and copied
file hashes. `LICENSE` is the upstream license and must ship with the runtime.

The bridge keeps the upstream Goal state machine, continuation rules, budget
checks, and native session entry format. It applies four small integration
patch sets in the vendored entry:

1. `registerGoalRuntime()` returns `{ runtime, commands, runController }` so
   `bridge-extension.mjs` can use the upstream control path without duplicating
   Goal behavior.
2. The legacy `pi-goal-state.json` cleanup function is a no-op. Native Pi
   `bridge-goal-state` entries are the source of truth for bridge sessions, so clearing
   a Goal must not delete or rewrite a user's global legacy state.
3. Bridge owned commands, tools, session entries, contracts, markers, and
   event channels use a `bridge-*` namespace. The shared
   `workflow:mutex:v1` channel remains unchanged so another Goal extension
   cannot run concurrently with this one.
4. State events carry the Goal snapshot captured when persisted, including
   cumulative usage and waiting changes. This preserves terminal usage after
   upstream clears its active Goal before emitting the queued terminal event.

The generated upstream files remain `.ts` files because Pi loads them through
its Jiti extension loader. The bridge entry only uses the runtime's public
factory and the event bus; it does not add an npm dependency or copy user
settings and credentials.

Only the bridge RPC control path is supported. The upstream TUI settings menu
requires `@narumitw/pi-tui-kit` and is outside this vendored integration.
