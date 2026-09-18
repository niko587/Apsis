/**
 * The owner goal, in code, so the planner's scope is not a matter of prose the
 * model may reinterpret.
 *
 * `AUTOPILOT_POLICY.md` is the human-readable version and is included in every
 * planner packet. This module is the default that applies when the owner does
 * not state one, and the out-of-scope list that travels with it.
 */

export const DEFAULT_OWNER_GOAL = `Finish and optimize the Apsis prototype /
product experience, according to this repository's existing architecture,
contracts, docs/CURRENT_STATE.md and docs/NEXT_ACTIONS.md.

Prefer: closing stated gaps, honest documentation, tests that would have caught
a real defect, measured performance work, and polish the owner would notice.

Do not expand the product's surface into anything on the out-of-scope list
below. If the repository looks finished with respect to this goal, choose the
smallest genuinely useful consolidation task rather than inventing a feature.`;

/**
 * Directions this tool may not wander in on its own initiative. Not a
 * permission system — the controller cannot tell what a diff will eventually be
 * used for — but a scope statement the planner is held to, and a checklist the
 * owner can hold a plan against.
 *
 * Every item is something with a consequence outside this repository: a real
 * person's data, a real bill, a real message sent to a real customer. The
 * reason they are off the table for an unattended loop is not that they are
 * hard. It is that they are not undoable.
 */
export const OUT_OF_SCOPE = Object.freeze([
  'production CRM integration',
  'real customer data ingestion',
  'a cloud database or any durable customer datastore',
  'billing, payments or subscription handling',
  'outbound calling, SMS or email vendors',
  'destructive migrations, or any migration of real data',
  'deployment to production, or changes to deployment credentials',
  'sending messages or posting anywhere outside this repository',
]);

export const policyText = () =>
  [
    DEFAULT_OWNER_GOAL,
    '',
    'Explicitly out of scope unless the owner changes the goal:',
    ...OUT_OF_SCOPE.map((item) => `- ${item}`),
  ].join('\n');
