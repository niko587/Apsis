/**
 * The one place authorization decisions are made.
 *
 * No provider import, and no role matrix. `capabilitiesFor` is a funnel: every
 * role, permission, entitlement and feature flag a provider might return enters
 * here and leaves as a set of capabilities. Endpoints then ask exactly one
 * question — `can(identity, 'interpreter:use')` — and never learn what a role
 * is.
 *
 * WHY A FUNNEL RATHER THAN CHECKING ROLES AT ENDPOINTS: the moment an endpoint
 * reads `role === 'admin'`, every future change to the role model becomes a
 * search across the codebase, and every endpoint becomes a place where the
 * check can be forgotten or written slightly differently. One funnel means
 * adding `viewer` later is an edit to this file.
 *
 * v1 rule: any authenticated identity gets `interpreter:use`, because there is
 * nothing yet to differentiate. That is a deliberate non-decision — the seam is
 * what this milestone is buying, not the policy.
 */

import type { Capability, Identity } from './identity';

/** Claims as they may arrive from a provider. Intentionally loose and optional. */
export interface ProviderClaims {
  role?: string;
  roles?: string[];
  permissions?: string[];
  entitlements?: string[];
  featureFlags?: string[];
}

export const ALL_CAPABILITIES: readonly Capability[] = ['interpreter:use'];

/**
 * Translate provider claims into capabilities.
 *
 * `claims` is accepted and currently unread. That is not an oversight: it is
 * the parameter that makes this function the place roles arrive, so adding a
 * policy later changes one signature-compatible body rather than a call site.
 */
export function capabilitiesFor(claims: ProviderClaims = {}): ReadonlySet<Capability> {
  void claims;
  // Everyone who has signed in may use the interpreter. When entitlements
  // exist, they are read here — e.g. a plan without AI would return an empty
  // set and every endpoint would refuse it without changing a line.
  return new Set<Capability>(['interpreter:use']);
}

export const can = (identity: Identity, capability: Capability): boolean =>
  identity.capabilities.has(capability);
