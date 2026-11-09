# OpenBooking agent-success benchmark

Measures how reliably AI agents complete real booking tasks against an OpenBooking MCP endpoint.

```sh
pnpm bench                       # all tasks, scripted baseline
pnpm bench --filter deposit      # subset
pnpm bench --driver scripted --driver claude   # once an LLM driver is registered
```

Each task runs against a **fresh, isolated server** (the demo restaurant, in-memory: joined tables, lunch seatings, pacing, a Sunday walk-in reserve and table time by party size, see `docs/RECIPES.md`) on a random port,
with a virtual clock anchored at the task's `now`. After the driver finishes, the runner inspects
the provider's booking state and records:

| Metric                         | Meaning                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success`                      | Outcome matches `expect.outcome`, and the booking matches the request (date, time window, party size, offering, preferences).                                                 |
| `double_bookings`              | Confirmed bookings beyond `expect.max_confirmed_bookings`, plus any overlapping holds or bookings on the same table. A booking on joined tables counts on each of its tables. |
| `expired_hold_errors`          | `hold_expired` errors the agent hit.                                                                                                                                          |
| `tool_calls`, `errors_by_code` | Efficiency and the kinds of errors the agent hit.                                                                                                                             |

Results are written to `bench/results/*.json`, which is gitignored.

## Tasks

`tasks/*.yaml` (schema in `src/types.ts`):

- `user_prompt`: what the simulated user says. LLM drivers only see this field.
- `intent`: the same request in structured form. The scripted baseline and the scorer use it.
- `setup`: existing bookings made before the run, to create contention.
- `inject.advance_clock_before_first_confirm_seconds`: simulates a slow user so the hold expires.
- `intent.must_end_by`: the party must be out by this time, so the agent has to read the slot's end (table time depends on the party size).
- `expect`: the expected outcome, the maximum number of confirmed bookings and, optionally, `tables`: how many tables the booking must occupy (2 = joined, 1 = a single table).

### Restaurant tasks

| Task                  | What it checks                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `sold-out-fallback`   | Both places for 8 (the 8-top and tables 6 and 7 joined) are booked at 20:00, so 19:00 would run into them.     |
| `joined-tables`       | A party of 7 when the 8-top is taken: the only fit is two tables pushed together (`expect.tables: 2`).         |
| `no-join-needed`      | A party of 5 fits one table: it must be booked on one table, not two (`expect.tables: 1`).                     |
| `pacing-full-evening` | The 19:00 arrivals cap (20 guests) is full although tables are free: the agent must take another time.         |
| `table-time-by-party` | Six guests get the table for 2 hours, so the 19:30 start overruns the "out by 21:00" the user gave.            |
| `walk-in-reserve`     | Sunday supper's online guests (24) are used up: nothing is offered, the agent must not book and should say so. |
| `lunch-seatings`      | Lunch starts only at fixed seatings (12:00, 13:15): the agent must pick a real one in the window.              |

Not covered yet (the features do not exist): waitlists and attempts to hoard tables (scalping).

## Drivers

- `ScriptedDriver`: a deterministic agent that follows the protocol perfectly. It validates the harness and sets the score ceiling.
- `LlmDriver`: **stub**. Implement a `ModelAdapter` for a model provider, then the tool loop in `src/drivers/llm.ts`:
  1. List the MCP tools.
  2. Send the system prompt and the user prompt.
  3. Execute tool calls over MCP.
  4. Answer the model's questions with a `SimulatedUser`.
  5. Stop on a final answer or the timeout.

  Register the driver in `src/cli.ts`.
