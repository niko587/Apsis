/**
 * Deterministic seed data.
 *
 * Apsis has no CRM wired to it yet, so the lead book is generated — but it is
 * generated ONCE, from a fixed seed, into real `Lead` records that then live or
 * die by the same event pipeline a real integration would drive. Reload the page
 * and you get the identical universe, which is what makes visual regressions and
 * performance numbers comparable between runs.
 *
 * Replacing this with a real source means replacing this file and nothing else.
 */

import type { Agent, AgentKind, Lead } from './types';
import { stageFor } from './scoring';
import { locationOf, pickMetro } from './geography';

/**
 * Stable 0..1 hash of a string id. FNV-1a plus a murmur3 finalizer.
 *
 * The finalizer is not optional. Plain FNV-1a avalanches poorly in its HIGH bits
 * for short, near-identical inputs — and `lead_0000`, `lead_0001`, … are exactly
 * that. Every caller here derives its value from the top bits (`h / 2^32` scaled),
 * so without the mix the output clustered badly: the first twenty leads produced
 * five distinct appointment offsets instead of sixteen, and the SMS/email channel
 * split came out 2641/2251 where it should be ~2544/2348.
 *
 * Shared rather than copied because both `agents.ts` and `appointments.ts` depend
 * on it, and a distribution bug fixed in one copy is a distribution bug still
 * live in the other.
 */
export function stableHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** mulberry32 — small, fast, fully deterministic. No Math.random anywhere. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  'Sarah', 'Mike', 'Elena', 'Marcus', 'Priya', 'Tom', 'Aisha', 'Daniel', 'Grace',
  'Victor', 'Nina', 'Omar', 'Claire', 'Jonah', 'Rosa', 'Peter', 'Lena', 'Andre',
  'Maya', 'Caleb', 'Ivy', 'Rashid', 'Tessa', 'Felix', 'Nadia', 'Owen', 'Bea',
];
const LAST = [
  'Martinez', 'Johnson', 'Okafor', 'Chen', 'Patel', 'Bergman', 'Rivera', 'Shaw',
  'Delacroix', 'Novak', 'Hassan', 'Whitfield', 'Kowalski', 'Ferrara', 'Adeyemi',
  'Lindqvist', 'Moreau', 'Castellanos', 'Reyes', 'Blackwood',
];
const OCCUPATIONS = [
  'Self-employed', 'Teacher', 'Contractor', 'Nurse', 'Retired', 'Retail manager',
  'Driver', 'Consultant', 'Chef', 'Engineer', 'Realtor', 'Small business owner',
];
const COVERAGE = [
  null, 'ACA Marketplace', 'Employer plan', 'COBRA', 'Short-term medical',
  'Medicare Advantage', 'Spouse plan',
];
const NEEDS = [
  'PPO preferred', 'January timeframe', 'Premium concern', 'Dental included',
  'Keep current doctor', 'Prescription coverage', 'Family of 4', 'Low deductible',
  'Immediate start', 'Vision included',
];
const CONTACT_PREF = ['phone', 'sms', 'email'] as const;

const SEGMENTS = [
  'Family Coverage', 'Individual', 'Medicare', 'Small Business', 'Self-Employed',
  'Supplemental', 'Dental + Vision',
];

const AGENT_SPECS: ReadonlyArray<{ kind: AgentKind; label: string; color: string }> = [
  { kind: 'call', label: 'Call Agent', color: '#7b8cff' },
  { kind: 'sms', label: 'SMS Agent', color: '#12c8e0' },
  { kind: 'email', label: 'Email Agent', color: '#ff45d0' },
  { kind: 'follow_up', label: 'Follow Up Agent', color: '#ffd23f' },
  { kind: 'qualification', label: 'Qualification Agent', color: '#ff9a1f' },
  { kind: 'booking', label: 'Booking Agent', color: '#2fe08a' },
  { kind: 'reactivation', label: 'Reactivation Agent', color: '#ff3b57' },
];

export function seedAgents(): Agent[] {
  return AGENT_SPECS.map((s) => ({
    id: `agent_${s.kind}`,
    kind: s.kind,
    label: s.label,
    color: s.color,
  }));
}

/**
 * Score distribution.
 *
 * Skewed hard toward cold on purpose — a real book is mostly unworked, and a
 * universe with an even spread across stages would flatter the pipeline and make
 * the center look cheap. `pow(u, 2.4)` gives a long cold rim, a thinning middle,
 * and a genuinely small set of booked appointments.
 */
function seededScore(u: number): number {
  return Math.pow(u, 2.4) * 100;
}

/** Two or three stated needs, never duplicated within a lead. */
function pickNeeds(rand: () => number): string[] {
  const out = new Set<string>();
  const n = 2 + Math.floor(rand() * 2);
  let guard = 0;
  while (out.size < n && guard++ < 20) out.add(NEEDS[Math.floor(rand() * NEEDS.length)]);
  return [...out];
}

export function seedLeads(count: number, seed = 0x5f3a21, now = Date.now()): Lead[] {
  const rand = rng(seed);
  const leads: Lead[] = [];
  const DAY = 1000 * 60 * 60 * 24;

  for (let i = 0; i < count; i++) {
    const score = seededScore(rand());
    const first = FIRST[Math.floor(rand() * FIRST.length)];
    const last = LAST[Math.floor(rand() * LAST.length)];
    // Golden-angle spacing so leads never clump into visible spokes, plus jitter
    // so the ring does not read as a machine-made lattice.
    const theta = i * 2.399963229728653 + rand() * 0.22;
    const createdAt = now - rand() * 90 * DAY;
    // Population-weighted, so the book reads like a national one: New York and
    // Los Angeles carry real mass, Cheyenne is a handful of nodes.
    const metro = pickMetro(rand());

    leads.push({
      id: `lead_${i.toString(36).padStart(4, '0')}`,
      name: `${first} ${last}`,
      company: null,
      location: locationOf(metro),
      segment: SEGMENTS[Math.floor(rand() * SEGMENTS.length)],
      score,
      stage: stageFor(score),
      theta,
      inclination: (rand() - 0.5) * 0.62,
      lastEventAt: createdAt + rand() * (now - createdAt),
      createdAt,
      appointmentAt: null,
      ownerAgentId: null,

      // §14 detail. Generated from the same seeded stream, so the whole book is
      // reproducible down to a lead's phone number.
      // Area code belongs to the metro. A Tampa lead with a Seattle number is
      // the kind of detail that quietly tells you the whole book is invented.
      phone: `(${metro.areaCode}) ${100 + Math.floor(rand() * 899)}-${1000 + Math.floor(rand() * 8999)}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      age: 24 + Math.floor(rand() * 52),
      occupation: OCCUPATIONS[Math.floor(rand() * OCCUPATIONS.length)],
      currentCoverage: COVERAGE[Math.floor(rand() * COVERAGE.length)],
      preferredContact: CONTACT_PREF[Math.floor(rand() * CONTACT_PREF.length)],
      needs: pickNeeds(rand),
      intent: rand(),
    });
  }
  return leads;
}
