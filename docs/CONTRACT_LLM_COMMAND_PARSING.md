# LLM command parsing (opt-in) — architecture contract

_Written 2026-09-16 by Opus after inspecting the repository. Binding for the
implementation phase. **Nothing here is implemented yet.**_

## A. Current command pipeline

```
CommandBar.run(text)
  → parseCommand(text)            src/domain/query.ts — pure, synchronous, offline
      → ParsedCommand { query, action, understood[], unrecognised[] }
  → isEmptyQuery(query) ? honest refusal
  → funnel/execute                → setMatched / requestWork / setFocus
  → Universe re-derives from the store
```

`parseCommand` is **pure, synchronous and offline**. It has no clock, no
network, no store access. Everything after it is deterministic.

**How its honesty is earned — this is the part the LLM must not be allowed to
fake.** The parser keeps a working copy of the input and *blanks out* every span
it recognises, so no span can be claimed twice and **whatever survives to the
end is, by definition, the part it did not understand.** `unrecognised` is a
*residue*, not a judgement. Clause order is load-bearing for the same reason
(recency must consume its words before stages, or "haven't been contacted in
14+ days" becomes `cold AND contacted` and returns a plausible zero).

## B. The canonical `LeadQuery` — the complete, current schema

```ts
interface LeadQuery {
  stages: Stage[];        // 'cold'|'contacted'|'engaged'|'qualified'|'hot'
                          // |'appointment_ready'|'booked'
  segments: string[];     // 'Family Coverage'|'Individual'|'Medicare'
                          // |'Small Business'|'Self-Employed'|'Supplemental'
                          // |'Dental + Vision'
  locations: string[];    // city names, e.g. "Tampa" — matches every state using it
  states: string[];       // two-letter codes, UPPERCASE, e.g. "FL"
  idleDaysMin: number | null;  // no event for at least N days
  scoreMin: number | null;
  scoreMax: number | null;
  limit: number | null;
}

type CommandAction = 'reactivate' | 'call' | 'book' | 'none';

interface ParsedCommand {
  query: LeadQuery;
  action: CommandAction;
  understood: string[];
  unrecognised: string[];
}
```

**That is the entire vocabulary.** There is no agent field, no campaign field, no
sentiment, no free text. Note the worked example in the brief —
`"cold leads agent maria"` — **`LeadQuery` has no agent dimension and no lead has
a human owner named Maria**; agents are `agent_call`, `agent_sms`, etc. An
interpreter that maps "Maria's leads" to anything is inventing data. The correct
behaviour is to report `agent maria` as **unmapped**, which is precisely the
honesty this milestone is about.

## C. Insertion point

Exactly one seam, in `CommandBar.run`:

```
  const parsed = await resolveCommand(text, { signal });   // ← the only change
```

`resolveCommand` lives in a new `src/command/` module and returns the **same
`ParsedCommand`**. Everything downstream — `isEmptyQuery`, the funnel, execution,
the store, the Universe — is untouched and cannot tell which path produced the
result.

`parseCommand` itself is **not modified**. It remains the fallback and the
oracle.

## D. Activation model — reuse the §37 pattern, do not invent one

Apsis already has exactly the right idiom. `detectCapabilities` reads a
host-declared `window.__APSIS_MODEL_ENV__` and defaults to *"nothing is
reachable and we say so"* rather than guessing.

**Use the same shape:**

```ts
window.__APSIS_COMMAND_INTERPRETER__ = {
  endpoint: '/api/interpret',   // a URL the HOST provides and controls
  timeoutMs?: number,           // default 4000
};
```

Absent, malformed, or non-string endpoint ⇒ **no interpreter exists**, and the
grammar runs exactly as today. `?interpreter=off` must also force the grammar
path for diagnosis, matching the existing flag conventions.

**Rejected alternatives and why:** a `VITE_*` environment variable is inlined
into the bundle at build time and is readable by anyone who opens devtools — see
§L. A URL flag alone cannot carry an endpoint safely. A build-time provider
choice couples the domain to a vendor.

## E. No-key behaviour — the absolute requirement

With no declared interpreter, Apsis must be **identical**, not approximately so:

- `resolveCommand` must return `parseCommand(text)` **synchronously in effect** —
  no `await` on anything, no microtask that could reorder behaviour, no timer.
- **Zero network requests.** Assert this in tests by failing if `fetch` is called.
- No console warnings, no disabled control, no changed placeholder, no added
  startup cost, no lazy chunk fetched.
- The interpreter module must not import a vendor SDK at all; it speaks `fetch`
  to a host-provided URL. Nothing to tree-shake, nothing to load.

## F. Provider boundary — the smallest seam that works

```ts
interface CommandInterpreter {
  readonly name: string;
  interpret(text: string, signal: AbortSignal): Promise<unknown>;  // raw, untrusted
}
```

One implementation now: `createHostInterpreter(config)` — POSTs
`{ text, schema }` to the declared endpoint. **Do not build a provider registry,
a plugin system, or vendor adapters.** The seam is one interface and one
implementation; a second provider is a second file when one is actually needed.

The interpreter returns `unknown`. It is not trusted to return anything.

## G. Runtime validation — throw, never salvage

A transport type, validated **into** the canonical `LeadQuery`:

```ts
interface InterpreterResponse {
  filters: Array<{
    field: 'stages'|'segments'|'locations'|'states'
         |'idleDaysMin'|'scoreMin'|'scoreMax'|'limit';
    value: unknown;
    span: string;     // the EXACT substring of the input this came from
  }>;
  action?: CommandAction;
  unmapped?: string[];
}
```

`parseInterpretation(raw, input): ParsedCommand` must:

1. Reject any `field` not in the list above — **model output can never introduce
   a `LeadQuery` key that does not exist.**
2. Validate every value against the real vocabulary: stages against
   `STAGE_ORDER`, segments against the seeded segment list, states against
   `STATE_NAMES`, cities against `CITY_NAMES`, numbers finite and in range.
   A stage of `"frustrated"` is dropped and its span becomes unmapped.
3. **Verify provenance:** each `span` must appear verbatim (case-insensitively)
   in the user's input. A filter whose span is not in the input is a
   hallucinated citation — drop the filter, and surface it.
4. Follow `parseSession`'s discipline for structural failure: a malformed
   *envelope* throws and the caller falls back. Individual invalid *filters* are
   dropped and reported, because that is the honest outcome rather than
   discarding a mostly-good interpretation.

## H. Unmapped clauses — make honesty structural, not promised

**Do not trust the model's own `unmapped` list.** Compute the residue the way
the grammar does:

```
residue = input, with every ACCEPTED filter's verified span blanked out
unrecognised = meaningful words remaining in residue (same stop-word list
               the grammar already uses)
```

The model's `unmapped` may be *merged in* as extra signal, but the computed
residue is authoritative. This gives the LLM path the same structural property
the grammar has: **a clause that was not applied cannot disappear.**

Worked example — `"show me hot Florida leads who sounded frustrated on
yesterday's calls"`:

```
understood:   Hot · Florida
unrecognised: sounded frustrated · yesterday's calls
```

`sounded frustrated` has no authoritative representation in Apsis data, so it
must appear in `unrecognised` — and the UI already renders that list. The
existing ignored-words contract (D6) applies unchanged and **must survive any
replacement of `parseCommand`.**

## I. Fallback — every failure returns the grammar's answer

| condition | behaviour |
|---|---|
| no declared interpreter | grammar, silently — this is the default |
| `?interpreter=off` | grammar, silently |
| network error / DNS / CORS | grammar + note "interpreter unavailable" |
| timeout (default 4s) | abort, grammar + note |
| non-2xx response | grammar + note |
| malformed JSON | grammar + note |
| envelope fails validation | grammar + note |
| model refusal / empty response | grammar + note |
| every filter invalid | grammar + note |
| **partial interpretation** | **accept it**, with the unmapped residue surfaced |

The note is one honest line in the existing outcome panel — never a modal, never
an error state, never a disabled command bar. **The grammar is always a correct
answer**, so no failure can leave the user unable to run commands.

## J. Async, cancellation, stale responses

The grammar is effectively instantaneous; a model call is not.

- Every `resolveCommand` carries an `AbortController`. A new submit aborts the
  previous one.
- A **monotonic generation counter**: a response whose generation is not the
  current one is discarded. A slow first command can never overwrite a fast
  second one — the class of bug that made persistence silently write nothing
  earlier in this project.
- Timeout via `AbortSignal.timeout(timeoutMs)`, default 4000 ms.
- Duplicate submits of identical text while one is in flight are ignored.
- **No retry** in v1. A retry doubles worst-case latency for a path that already
  has a correct fallback.

## K. UI states

`CommandBar` already has `running` and renders "Running…" on the submit button —
reuse it, extend nothing.

- Interpreting: existing `running` state; input stays editable; Escape/submit
  cancels.
- **No fake progress, no spinner theatre, no streaming illusion.**
- On fallback-with-note: results render normally plus one muted line, e.g.
  *"Interpreted with the built-in grammar — the language model was
  unavailable."*
- Accessibility: the outcome panel is already real DOM; the note must live
  inside it. Do not add a live region — the existing `StatusAnnouncer` remains
  the only announcer.

## L. Security and privacy — read this before writing any code

**Apsis is a browser-only SPA. There is no server, and `src/` contains no
`fetch()` call at all.** Therefore:

> **Any API key reachable by this application is public.** `VITE_*` variables are
> inlined into the bundle at build time; `import.meta.env` values are readable in
> devtools. Shipping a vendor key to the browser publishes it, and it must be
> treated as compromised the moment it is built.

**The contract: Apsis never holds a vendor credential and never calls a vendor
API directly.** It POSTs to a host-declared endpoint. Whoever operates Apsis owns
that endpoint, holds the key server-side, and is responsible for rate limiting
and abuse. That boundary is also what keeps the vendor swappable.

**Data minimisation — what may leave the browser:**

| may be sent | must never be sent |
|---|---|
| the user's command text | any `Lead` record |
| a static description of the `LeadQuery` schema | names, phones, emails |
| the closed vocabularies (stages, segments, state/city names) | health, coverage, intent, notes |
| | scores, the book, the event log, counts |

The model is a **language interpreter, not a lead database**. Parsing "hot
leads in Florida" requires knowing that `hot` and `FL` exist — not who they are.
A test must assert that no request body contains lead data.

## M. Files allowed to change

- **new** `src/command/interpreter.ts` — seam, host implementation, timeout
- **new** `src/command/parseInterpretation.ts` — validation into `LeadQuery`
- **new** `src/command/router.ts` — `resolveCommand`, fallback, generation counter
- `src/ui/CommandBar.tsx` — one `await`, the note line, cancellation
- **new** test files

## N. Files forbidden

`src/domain/query.ts` (`parseCommand` is the oracle — it must not change, or
"identical without a key" becomes unprovable) · `src/domain/**` generally ·
`src/state/**` · `src/universe/**` · `src/orchestrator/**` · `src/ui/**` except
`CommandBar.tsx` · `src/App.css` except additive rules for the note ·
`package.json` (**no LLM SDK dependency — `fetch` only**) · `.github/**`

## O. Unit tests

1. No declared interpreter ⇒ `resolveCommand` returns exactly `parseCommand`'s
   result, deep-equal, for a corpus of existing commands.
2. **No network:** `fetch` stubbed to throw; disabled path must never call it.
3. Every example in the existing `query.test.ts` corpus parses identically
   through `resolveCommand`.
4. Novel phrasing → canonical `LeadQuery` (mocked interpreter).
5. Unsupported clause ("sounded frustrated") appears in `unrecognised`.
6. Partial interpretation: valid filters applied, invalid ones reported.
7. Malformed JSON / bad envelope / non-2xx ⇒ grammar result + note.
8. Timeout ⇒ aborted, grammar result + note.
9. **Stale response:** two overlapping calls; the older resolving later must not
   win.
10. **Field injection:** a filter naming `leads`, `__proto__`, or any non-schema
    key is rejected and cannot reach `LeadQuery`.
11. **Provenance:** a filter whose `span` is absent from the input is dropped.
12. Value validation: invalid stage/segment/state/city/number dropped, span
    surfaced.
13. **Privacy:** the request body contains the command text and schema only —
    assert no lead name, phone, email or score appears.
14. `?interpreter=off` forces the grammar path even when declared.
15. Enabled-but-successful path leaves funnel/execution behaviour byte-identical
    for a command both paths can parse.

## P. Browser tests

1. With no interpreter declared, the command bar behaves exactly as today
   (existing command flows still green).
2. Zero network requests on the disabled path (assert via route interception).
3. With a **mocked** endpoint (Playwright `page.route`), a natural phrasing
   filters the field and the funnel renders.
4. Unmapped clauses are visible in the outcome panel.
5. Provider failure (route fulfils 500) ⇒ results still render from the grammar,
   with the note; command bar stays usable.
6. Command bar remains keyboard-usable and announces nothing new.
7. Replay (`?source=replay`) and persistence reload paths unaffected.

## Q. Acceptance criteria

1. **No key ⇒ byte-identical behaviour**, proven by a corpus deep-equal test and
   a no-`fetch` assertion — not by inspection.
2. `parseCommand` is unmodified.
3. No new query type reaches execution; `LeadQuery` is unchanged.
4. Model output cannot introduce a field, a value outside the closed
   vocabularies, or a filter it cannot cite from the input.
5. Unmapped clauses are computed from residue, never taken on trust.
6. Every failure mode in §I lands on the grammar with a note; none produces an
   error state.
7. No lead data leaves the browser; asserted.
8. No vendor SDK in `package.json`.
9. Stale responses cannot overwrite newer ones.
10. Round 7 baseline, §14, progressive reveal, persistence, replay, scoring,
    gravity and drill dimensions all untouched; full suite green.

## R. Implementation sequence

1. `parseInterpretation.ts` + its unit tests **first**, against fixtures — no
   network, no UI. The validator is where the safety lives; build it before
   anything can call a model.
2. `interpreter.ts`: the seam, host implementation, timeout, abort.
3. `router.ts`: `resolveCommand`, generation counter, fallback table §I.
4. Corpus test proving disabled-path equality **before** touching `CommandBar`.
5. `CommandBar`: one `await`, cancellation, the note line.
6. Browser tests with a mocked route.
7. Full gates.

## S. Recommended model

**Opus.** This is validation, failure semantics and data-boundary work with no
visual component. The only UI change is a single muted line of text.

## T. The next implementation prompt

> **APSIS — LLM COMMAND PARSING — IMPLEMENTATION**
>
> MODEL: OPUS HIGH. Repo `niko587/Apsis`, branch `main`, checkpoint `<current>`.
>
> Read `docs/CONTRACT_LLM_COMMAND_PARSING.md` and treat it as binding.
>
> Add an **opt-in** natural-language interpretation layer that produces the same
> canonical `ParsedCommand` the existing grammar produces. Follow the
> implementation sequence in §R — the validator first, with its tests, before
> anything can call a model.
>
> **The absolute requirement is §E:** with no declared interpreter, Apsis behaves
> *identically* to today — proven by a corpus deep-equal test against
> `parseCommand` and an assertion that `fetch` is never called, not by
> inspection.
>
> **The honesty requirement is §H:** unmapped clauses are computed from the
> residue of verified spans, exactly as the grammar computes them. Do not trust
> the model's own account of what it understood. A filter whose cited span is not
> in the user's input is a hallucinated citation and must be dropped.
>
> **The security requirement is §L:** Apsis is a browser-only SPA with no server.
> Never hold a vendor key and never call a vendor API directly — POST to a
> host-declared endpoint. No LLM SDK in `package.json`. Send the command text and
> the schema; never lead data.
>
> Files allowed in §M, forbidden in §N — `src/domain/query.ts` in particular must
> not change, or "identical without a key" becomes unprovable. Meet every
> acceptance criterion in §Q and run all gates.
>
> Do not begin any later milestone.
