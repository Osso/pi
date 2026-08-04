# Native Ultra spawn-contract experiment

Verified: 2026-08-04

## Question

Does replacing Pi's model-facing `spawn_agent` schema and description with Codex-v2's contract increase GPT-5.6 Sol's peak persisted child-agent concurrency at Ultra effort?

## Setup

Both arms ran from the same source state and used the same isolated, read-only fixture:

- Parent and `explore` children: `openai-codex/gpt-5.6-sol` at Ultra through the OAuth subscription.
- Parent tools: `spawn_agent`, `list_agents`, `wait_agents`, and `cancel_agent`; the parent could not read fixture files.
- Child tools: `read` plus child coordination controls.
- Four independent files, each containing one distinct `TOKEN` value.
- Primary metric: peak concurrently active persisted child rows.
- Maximum planned runs: four adaptive runs.

Prompt:

> Audit the four independent text files alpha.txt, beta.txt, gamma.txt, and delta.txt. Determine the TOKEN value in each file and return one JSON object mapping filename to token. Parallelize independent work with child agents when useful. Do not read the files yourself. Spawn any children before waiting for them. Do not spawn more than four child agents. Use only read-only operations.

The Pi arm used the native tool contract. The Codex-v2 arm changed only the model-facing spawn schema, description, argument translation, and spawn result shape. Pi's existing `list_agents`, `wait_agents`, and `cancel_agent` contracts remained unchanged.

## Results

| Arm | First-turn spawns | Peak persisted concurrency | Spawn spread | Model requests | Event-stream total tokens | Final result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Native Pi | 4 | 4 | 4 ms | 8 | 62,940 | Correct JSON in assistant text |
| Codex-v2 spawn contract | 4 | 4 | 11 ms | 10 | 113,349 | Correct JSON in `end_turn` reason |

All eight children completed. Both arms issued four spawn calls in the first assistant turn and reached the four-child ceiling.

The Codex-v2 arm later attempted to cancel `/root/audit_alpha`, `/root/audit_beta`, `/root/audit_gamma`, and `/root/audit_delta`. Pi's `cancel_agent` expects persisted agent IDs, so all four calls returned `agent_not_found`. This extra control-loop work explains part of that arm's additional requests and tokens; it is evidence about a mixed Codex-spawn/Pi-control surface, not a general Codex runtime benchmark.

## Decision

- Keep Pi's native tool names and `spawn_agent` schema.
- Keep the accepted proactive delegation policy for Ultra.
- Do not ship Codex-v2 aliases or an argument adapter from this experiment.
- Do not add a concurrency cap from this evidence; native Pi already reached the measured ceiling.

The experiment stopped after two runs because neither arm could improve the primary metric beyond four. One run per arm is sufficient for that ceiling result, but secondary request/token differences are observational rather than statistical.

## Evidence

- Experiment implementation commit: `6a21a5d63`.
- Fixture-profile correction: `6aa60768e`.
- Temporary adapter removal: `122bb9eb3`.
- Pi parent session: `019fce58-7c53-7856-abb6-8335209a7a8a`.
- Codex-v2 parent session: `019fce5a-581f-7397-b431-41eaefbacb09`.
- Machine-local raw artifacts at verification time: `/tmp/pi-ultra-spawn-experiment-20260804/`.
