/**
 * The command interface.
 *
 * §13 asks for: parse → show what Apsis understood → identify affected leads →
 * execute → stream progress → show the result. That is the shape below.
 *
 * The readout shows both halves of the parse — what was understood AND what was
 * not. A command whose key clause was silently dropped returns a confident,
 * wrong answer, and nothing on screen would tell you.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  describeCommand,
  isEmptyQuery,
  parseCommand,
  runQuery,
  type CommandAction,
  type FunnelStep,
} from '../domain/query';
import type { LeadEventKind } from '../domain/types';
import { useApsis } from '../state/store';

const EXAMPLES = [
  "find all cold family leads in Tampa that haven't been contacted in 14+ days, start the reactivation sequence",
  'find hot medicare leads in Orlando, call them',
  'show qualified leads with score above 80, top 25',
];

/** What each action actually does to a lead. */
const ACTION_EMITS: Record<Exclude<CommandAction, 'none'>, LeadEventKind> = {
  reactivate: 'contacted',
  call: 'call_connected',
  book: 'appointment_offered',
};

interface Outcome {
  understood: string[];
  unrecognised: string[];
  funnel: FunnelStep[];
  matched: number;
  action: CommandAction;
  dispatched: number | null;
  /** Set when the command produced nothing actionable. */
  note: string | null;
}

export function CommandBar() {
  const [input, setInput] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);

  const setMatched = useApsis((s) => s.setMatched);
  const requestWork = useApsis((s) => s.requestWork);
  const setFocus = useApsis((s) => s.setFocus);

  const placeholder = useMemo(() => EXAMPLES[0], []);

  const run = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setRunning(true);

      const parsed = parseCommand(text);
      const { query, action, understood, unrecognised } = parsed;

      if (isEmptyQuery(query)) {
        setMatched(null);
        setFocus(null);
        setOutcome({
          understood,
          unrecognised,
          funnel: [],
          matched: 0,
          action,
          dispatched: null,
          note: 'No filter recognised — nothing to run. Name a stage, segment, city, recency or score.',
        });
        setRunning(false);
        return;
      }

      const { leads } = useApsis.getState();
      const { leadIds, funnel } = runQuery(query, leads.values(), Date.now());
      setMatched(leadIds);
      // Describe what was UNDERSTOOD, not what was typed — see describeCommand.
      setFocus(leadIds.length > 0 ? describeCommand(parsed) : null);

      let dispatched: number | null = null;
      if (action !== 'none' && leadIds.length > 0) {
        const kind = ACTION_EMITS[action];
        let n = 0;
        // Dispatch is real: each of these opens an AgentTask that occupies an
        // agent, draws an arc, and resolves into an event that moves the lead.
        for (const id of leadIds) {
          if (requestWork(id, kind)) n++;
        }
        dispatched = n;
      }

      setOutcome({
        understood,
        unrecognised,
        funnel,
        matched: leadIds.length,
        action,
        dispatched,
        note:
          leadIds.length === 0
            ? 'No leads match. Try relaxing a clause.'
            : action !== 'none' && dispatched === 0
              ? 'Every matched lead is already being worked by an agent.'
              : null,
      });
      setRunning(false);
    },
    [requestWork, setMatched, setFocus],
  );

  const clear = () => {
    setOutcome(null);
    setMatched(null);
    setFocus(null);
    setInput('');
  };

  return (
    <div className="command">
      <form
        className="command-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(input);
        }}
      >
        <span className="command-mark" />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          aria-label="Command Apsis"
          spellCheck={false}
        />
        {outcome && (
          <button type="button" className="command-clear" onClick={clear}>
            clear
          </button>
        )}
        <button type="submit" className="command-send" disabled={running || !input.trim()}>
          {running ? 'Running…' : 'Run'}
        </button>
      </form>

      {outcome && (
        <div className="command-out">
          <div className="understood">
            {outcome.understood.length > 0 ? (
              outcome.understood.map((u) => (
                <span key={u} className="chip">
                  {u}
                </span>
              ))
            ) : (
              <span className="chip chip-none">nothing recognised</span>
            )}
            {outcome.unrecognised.map((u) => (
              <span key={u} className="chip chip-unknown" title="Apsis ignored this">
                ignored: {u}
              </span>
            ))}
          </div>

          {outcome.funnel.length > 0 && (
            <ol className="funnel">
              {outcome.funnel.map((f, i) => (
                <li key={`${f.label}-${i}`}>
                  <span className="funnel-n">{f.remaining.toLocaleString()}</span>
                  <span className="funnel-l">{f.label}</span>
                </li>
              ))}
            </ol>
          )}

          <div className="command-result">
            {outcome.note ? (
              <span className="muted">{outcome.note}</span>
            ) : (
              <>
                <strong>{outcome.matched.toLocaleString()}</strong> leads matched
                {outcome.dispatched !== null && (
                  <>
                    {' · '}
                    <strong className="accent-text">{outcome.dispatched}</strong> agent
                    {outcome.dispatched === 1 ? '' : 's'} dispatched
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {!outcome && (
        <div className="command-examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => { setInput(ex); void run(ex); }}>
              {ex}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
