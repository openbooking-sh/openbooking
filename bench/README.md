# OpenBooking agent-success benchmark

Measures how reliably AI agents complete real booking tasks against an OpenBooking MCP endpoint.

```sh
pnpm bench                       # all tasks, scripted baseline
pnpm bench --filter deposit      # subset
pnpm bench --driver scripted --driver claude   # once an LLM driver is registered
```

Each task runs against a **fresh, isolated server** (demo restaurant, in-memory) on a random port,
with a virtual clock anchored at the task's `now`. After the driver finishes, the runner inspects
the provider's booking state and records:

| Metric                         | Meaning                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `success`                      | Outcome matches `expect.outcome`, and the booking matches the request (date, time window, party size, offering, preferences). |
| `double_bookings`              | Confirmed bookings beyond `expect.max_confirmed_bookings`, plus any overlapping holds or bookings on the same table.          |
| `expired_hold_errors`          | `hold_expired` errors the agent hit.                                                                                          |
| `tool_calls`, `errors_by_code` | Efficiency and the kinds of errors the agent hit.                                                                             |

Results are written to `bench/results/*.json`, which is gitignored.

## Tasks

`tasks/*.yaml` (schema in `src/types.ts`):

- `user_prompt`: what the simulated user says. LLM drivers only see this field.
- `intent`: the same request in structured form. The scripted baseline and the scorer use it.
- `setup`: existing bookings made before the run, to create contention.
- `inject.advance_clock_before_first_confirm_seconds`: simulates a slow user so the hold expires.
- `expect`: the expected outcome and the maximum number of confirmed bookings.

## Drivers

- `ScriptedDriver`: a deterministic agent that follows the protocol perfectly. It validates the harness and sets the score ceiling.
- `LlmDriver`: **stub**. Implement a `ModelAdapter` for a model provider, then the tool loop in `src/drivers/llm.ts`:
  1. List the MCP tools.
  2. Send the system prompt and the user prompt.
  3. Execute tool calls over MCP.
  4. Answer the model's questions with a `SimulatedUser`.
  5. Stop on a final answer or the timeout.

  Register the driver in `src/cli.ts`.
