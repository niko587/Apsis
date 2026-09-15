/**
 * US geography for the lead book.
 *
 * The book used to be nine Florida cities, which made the §15 drill dishonest:
 * the first level offered exactly one choice and `GLOBAL → Florida` went from
 * 4,892 leads to 4,892 leads. A drill level that cannot partition anything is a
 * click that costs the user a step and returns nothing.
 *
 * Metros are weighted by population, so the field reads like a real national
 * book — New York and Los Angeles carry real mass, Cheyenne and Burlington are
 * a scattering of nodes — rather than a uniform sprinkle that would make every
 * state look equally worked. Area codes are real and belong to their metro,
 * because a Tampa lead with a Seattle phone number is the kind of detail that
 * quietly tells you the whole book is fake.
 *
 * Regions are the US Census divisions. They exist so the first drill level has
 * four legible choices instead of forty-four: Universe → region → state → city
 * → segment, each level partitioning the one above it into something a person
 * can scan.
 */

export type Region = 'Northeast' | 'Midwest' | 'South' | 'West';

export const REGION_ORDER: readonly Region[] = [
  'Northeast',
  'Midwest',
  'South',
  'West',
];

export interface Metro {
  readonly city: string;
  /** Two-letter postal code. `DC` is included and treated as a state. */
  readonly state: string;
  readonly region: Region;
  /** A real area code for this metro. */
  readonly areaCode: number;
  /** Metro population in millions — the sampling weight. */
  readonly weight: number;
}

export const METROS: readonly Metro[] = [
  // ---- Northeast ----
  { city: 'New York', state: 'NY', region: 'Northeast', areaCode: 212, weight: 20.1 },
  { city: 'Philadelphia', state: 'PA', region: 'Northeast', areaCode: 215, weight: 6.2 },
  { city: 'Boston', state: 'MA', region: 'Northeast', areaCode: 617, weight: 4.9 },
  { city: 'Newark', state: 'NJ', region: 'Northeast', areaCode: 973, weight: 2.5 },
  { city: 'Pittsburgh', state: 'PA', region: 'Northeast', areaCode: 412, weight: 2.4 },
  { city: 'Providence', state: 'RI', region: 'Northeast', areaCode: 401, weight: 1.6 },
  { city: 'Hartford', state: 'CT', region: 'Northeast', areaCode: 860, weight: 1.2 },
  { city: 'Buffalo', state: 'NY', region: 'Northeast', areaCode: 716, weight: 1.1 },
  { city: 'Rochester', state: 'NY', region: 'Northeast', areaCode: 585, weight: 1.1 },
  { city: 'Worcester', state: 'MA', region: 'Northeast', areaCode: 508, weight: 0.98 },
  { city: 'Albany', state: 'NY', region: 'Northeast', areaCode: 518, weight: 0.9 },
  { city: 'Portland', state: 'ME', region: 'Northeast', areaCode: 207, weight: 0.55 },
  { city: 'Manchester', state: 'NH', region: 'Northeast', areaCode: 603, weight: 0.42 },
  { city: 'Burlington', state: 'VT', region: 'Northeast', areaCode: 802, weight: 0.23 },

  // ---- Midwest ----
  { city: 'Chicago', state: 'IL', region: 'Midwest', areaCode: 312, weight: 9.5 },
  { city: 'Detroit', state: 'MI', region: 'Midwest', areaCode: 313, weight: 4.3 },
  { city: 'Minneapolis', state: 'MN', region: 'Midwest', areaCode: 612, weight: 3.7 },
  { city: 'St. Louis', state: 'MO', region: 'Midwest', areaCode: 314, weight: 2.8 },
  { city: 'Cincinnati', state: 'OH', region: 'Midwest', areaCode: 513, weight: 2.3 },
  { city: 'Kansas City', state: 'MO', region: 'Midwest', areaCode: 816, weight: 2.2 },
  { city: 'Columbus', state: 'OH', region: 'Midwest', areaCode: 614, weight: 2.1 },
  { city: 'Indianapolis', state: 'IN', region: 'Midwest', areaCode: 317, weight: 2.1 },
  { city: 'Cleveland', state: 'OH', region: 'Midwest', areaCode: 216, weight: 2.1 },
  { city: 'Milwaukee', state: 'WI', region: 'Midwest', areaCode: 414, weight: 1.6 },
  { city: 'Grand Rapids', state: 'MI', region: 'Midwest', areaCode: 616, weight: 1.1 },
  { city: 'Omaha', state: 'NE', region: 'Midwest', areaCode: 402, weight: 0.97 },
  { city: 'Des Moines', state: 'IA', region: 'Midwest', areaCode: 515, weight: 0.71 },
  { city: 'Madison', state: 'WI', region: 'Midwest', areaCode: 608, weight: 0.68 },
  { city: 'Wichita', state: 'KS', region: 'Midwest', areaCode: 316, weight: 0.65 },
  { city: 'Sioux Falls', state: 'SD', region: 'Midwest', areaCode: 605, weight: 0.28 },
  { city: 'Fargo', state: 'ND', region: 'Midwest', areaCode: 701, weight: 0.25 },

  // ---- South ----
  { city: 'Dallas', state: 'TX', region: 'South', areaCode: 214, weight: 7.6 },
  { city: 'Houston', state: 'TX', region: 'South', areaCode: 713, weight: 7.1 },
  { city: 'Washington', state: 'DC', region: 'South', areaCode: 202, weight: 6.3 },
  { city: 'Atlanta', state: 'GA', region: 'South', areaCode: 404, weight: 6.1 },
  { city: 'Miami', state: 'FL', region: 'South', areaCode: 305, weight: 6.1 },
  { city: 'Tampa', state: 'FL', region: 'South', areaCode: 813, weight: 3.2 },
  { city: 'Baltimore', state: 'MD', region: 'South', areaCode: 410, weight: 2.8 },
  { city: 'Charlotte', state: 'NC', region: 'South', areaCode: 704, weight: 2.7 },
  { city: 'Orlando', state: 'FL', region: 'South', areaCode: 407, weight: 2.7 },
  { city: 'San Antonio', state: 'TX', region: 'South', areaCode: 210, weight: 2.6 },
  { city: 'Austin', state: 'TX', region: 'South', areaCode: 512, weight: 2.3 },
  { city: 'Nashville', state: 'TN', region: 'South', areaCode: 615, weight: 2.0 },
  { city: 'Virginia Beach', state: 'VA', region: 'South', areaCode: 757, weight: 1.8 },
  { city: 'Jacksonville', state: 'FL', region: 'South', areaCode: 904, weight: 1.6 },
  { city: 'Oklahoma City', state: 'OK', region: 'South', areaCode: 405, weight: 1.4 },
  { city: 'Raleigh', state: 'NC', region: 'South', areaCode: 919, weight: 1.4 },
  { city: 'Memphis', state: 'TN', region: 'South', areaCode: 901, weight: 1.3 },
  { city: 'Richmond', state: 'VA', region: 'South', areaCode: 804, weight: 1.3 },
  { city: 'Louisville', state: 'KY', region: 'South', areaCode: 502, weight: 1.3 },
  { city: 'New Orleans', state: 'LA', region: 'South', areaCode: 504, weight: 1.3 },
  { city: 'Birmingham', state: 'AL', region: 'South', areaCode: 205, weight: 1.1 },
  { city: 'Greenville', state: 'SC', region: 'South', areaCode: 864, weight: 0.93 },
  { city: 'Knoxville', state: 'TN', region: 'South', areaCode: 865, weight: 0.88 },
  { city: 'Sarasota', state: 'FL', region: 'South', areaCode: 941, weight: 0.86 },
  { city: 'Columbia', state: 'SC', region: 'South', areaCode: 803, weight: 0.84 },
  { city: 'Charleston', state: 'SC', region: 'South', areaCode: 843, weight: 0.8 },
  { city: 'Fort Myers', state: 'FL', region: 'South', areaCode: 239, weight: 0.79 },
  { city: 'Little Rock', state: 'AR', region: 'South', areaCode: 501, weight: 0.75 },
  { city: 'Wilmington', state: 'DE', region: 'South', areaCode: 302, weight: 0.72 },
  { city: 'Jackson', state: 'MS', region: 'South', areaCode: 601, weight: 0.59 },
  { city: 'Huntsville', state: 'AL', region: 'South', areaCode: 256, weight: 0.5 },
  { city: 'Charleston', state: 'WV', region: 'South', areaCode: 304, weight: 0.25 },
  { city: 'Naples', state: 'FL', region: 'South', areaCode: 239, weight: 0.4 },
  { city: 'Ocala', state: 'FL', region: 'South', areaCode: 352, weight: 0.38 },

  // ---- West ----
  { city: 'Los Angeles', state: 'CA', region: 'West', areaCode: 213, weight: 13.2 },
  { city: 'Phoenix', state: 'AZ', region: 'West', areaCode: 602, weight: 5.0 },
  { city: 'San Francisco', state: 'CA', region: 'West', areaCode: 415, weight: 4.7 },
  { city: 'Seattle', state: 'WA', region: 'West', areaCode: 206, weight: 4.0 },
  { city: 'San Diego', state: 'CA', region: 'West', areaCode: 619, weight: 3.3 },
  { city: 'Denver', state: 'CO', region: 'West', areaCode: 303, weight: 3.0 },
  { city: 'Portland', state: 'OR', region: 'West', areaCode: 503, weight: 2.5 },
  { city: 'Sacramento', state: 'CA', region: 'West', areaCode: 916, weight: 2.4 },
  { city: 'Las Vegas', state: 'NV', region: 'West', areaCode: 702, weight: 2.3 },
  { city: 'San Jose', state: 'CA', region: 'West', areaCode: 408, weight: 2.0 },
  { city: 'Salt Lake City', state: 'UT', region: 'West', areaCode: 801, weight: 1.3 },
  { city: 'Tucson', state: 'AZ', region: 'West', areaCode: 520, weight: 1.1 },
  { city: 'Fresno', state: 'CA', region: 'West', areaCode: 559, weight: 1.0 },
  { city: 'Honolulu', state: 'HI', region: 'West', areaCode: 808, weight: 1.0 },
  { city: 'Albuquerque', state: 'NM', region: 'West', areaCode: 505, weight: 0.92 },
  { city: 'Boise', state: 'ID', region: 'West', areaCode: 208, weight: 0.79 },
  { city: 'Colorado Springs', state: 'CO', region: 'West', areaCode: 719, weight: 0.76 },
  { city: 'Spokane', state: 'WA', region: 'West', areaCode: 509, weight: 0.6 },
  { city: 'Reno', state: 'NV', region: 'West', areaCode: 775, weight: 0.5 },
  { city: 'Anchorage', state: 'AK', region: 'West', areaCode: 907, weight: 0.4 },
  { city: 'Billings', state: 'MT', region: 'West', areaCode: 406, weight: 0.19 },
  { city: 'Cheyenne', state: 'WY', region: 'West', areaCode: 307, weight: 0.1 },
];

export const STATE_NAMES: Readonly<Record<string, string>> = {
  AK: 'Alaska', AL: 'Alabama', AR: 'Arkansas', AZ: 'Arizona', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DC: 'District of Columbia', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', IA: 'Iowa', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine', MI: 'Michigan',
  MN: 'Minnesota', MO: 'Missouri', MS: 'Mississippi', MT: 'Montana',
  NC: 'North Carolina', ND: 'North Dakota', NE: 'Nebraska', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NV: 'Nevada', NY: 'New York',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VA: 'Virginia', VT: 'Vermont', WA: 'Washington',
  WI: 'Wisconsin', WV: 'West Virginia', WY: 'Wyoming',
};

/** state code → region, derived from METROS so the two can never disagree. */
export const STATE_REGION: Readonly<Record<string, Region>> = Object.fromEntries(
  METROS.map((m) => [m.state, m.region]),
);

/** `"Tampa, FL"` → `"FL"`. Every location in the book carries the suffix. */
export const stateOf = (location: string): string => location.slice(-2);

export const regionOf = (location: string): Region | null =>
  STATE_REGION[stateOf(location)] ?? null;

export const locationOf = (m: Metro): string => `${m.city}, ${m.state}`;

/** Every distinct location string the book can contain. */
export const LOCATIONS: readonly string[] = METROS.map(locationOf);

/**
 * City names for the command parser, LONGEST FIRST.
 *
 * Order matters: matching `"Charleston"` before `"Charleston, SC"` is harmless,
 * but matching `"Kansas"` before `"Kansas City"` would consume half the city
 * name and leave `"city"` behind as an unrecognised word. Longest-first makes
 * the greedy scan correct without any lookahead.
 */
export const CITY_NAMES: readonly string[] = [
  ...new Set(METROS.map((m) => m.city)),
].sort((a, b) => b.length - a.length || a.localeCompare(b));

/**
 * Two metros share a city name (`Charleston, SC` and `Charleston, WV`), so a
 * bare city filter has to match every state that uses the name. Callers filter
 * on the city part rather than the whole location string for exactly this
 * reason.
 */
export const cityOf = (location: string): string => {
  const comma = location.indexOf(',');
  return comma > 0 ? location.slice(0, comma) : location;
};

/** Cumulative weights, built once. */
const CUMULATIVE: readonly number[] = (() => {
  const out: number[] = [];
  let sum = 0;
  for (const m of METROS) {
    sum += m.weight;
    out.push(sum);
  }
  return out;
})();

const TOTAL_WEIGHT = CUMULATIVE[CUMULATIVE.length - 1];

/**
 * Population-weighted metro for a uniform `u` in [0, 1).
 *
 * Binary search rather than a linear scan: the seed calls this once per lead,
 * and at `?leads=60000` a linear walk over 90 metros is 2.7M comparisons for
 * no reason.
 */
export function pickMetro(u: number): Metro {
  const target = u * TOTAL_WEIGHT;
  let lo = 0;
  let hi = CUMULATIVE.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (CUMULATIVE[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return METROS[lo];
}
