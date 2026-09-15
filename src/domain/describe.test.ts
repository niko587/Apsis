import { describe, expect, it } from 'vitest';
import { describeCommand, parseCommand } from './query';

describe('describeCommand (§17 current focus)', () => {
  it('reads as the sentence the reference brief shows', () => {
    const p = parseCommand(
      "find all cold family leads in Tampa that haven't been contacted in 14+ days, start the reactivation sequence",
    );
    const s = describeCommand(p);
    expect(s).toMatch(/^Reactivating/);
    expect(s).toContain('cold');
    expect(s).toContain('family');
    expect(s).toContain('Tampa');
    expect(s).toContain('idle 14+ days');
  });

  it('uses the verb for the parsed action', () => {
    expect(describeCommand(parseCommand('find hot leads in Miami, call them'))).toMatch(
      /^Calling/,
    );
    expect(describeCommand(parseCommand('book appointment-ready leads'))).toMatch(/^Booking/);
    expect(describeCommand(parseCommand('show cold leads in Naples'))).toMatch(/^Reviewing/);
  });

  it('describes only what was understood, never the raw input', () => {
    // The point of building this from the PARSED command: a clause Apsis ignored
    // must not reappear in the focus line as though it were being acted on.
    const s = describeCommand(parseCommand('find hot leads with a golden retriever in Miami'));
    expect(s).not.toMatch(/golden|retriever/i);
    expect(s).toContain('Miami');
  });

  it('stays readable when only one clause was given', () => {
    expect(describeCommand(parseCommand('find cold leads'))).toBe('Reviewing cold leads');
  });
});
