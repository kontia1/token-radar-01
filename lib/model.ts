// The token radar's model: one sealed DefiLlama snapshot in, one ranked board out.
//
// WHAT IS BEING RANKED
// A protocol's "launch" is the token it may issue one day. The board ranks protocols that, in the
// snapshot's own record, carry no token at all (mcap_usd, gecko_id and symbol all null). Every other
// protocol in the file already has a token that trades, so it is not a launch to be early on: those are
// counted, reported in the page's header, and left off the board. Nothing here predicts whether a token
// is ever issued, or when. It answers one narrower question: if this protocol's record stayed exactly as
// it is, how large a float would a token on top of it plausibly carry, and what should a reader do about
// it before that token exists.
//
// THE FORMULA, AND WHY EACH FACTOR IS THERE
//
//   base      = tvl_usd x MODEL.value_share
//   growth    = 1 + (clamp(change_7d) / 100) x MODEL.growth_weight
//   age       = MODEL.age_floor + min(age_days, MODEL.age_full_days)/MODEL.age_full_days x MODEL.age_range
//   category  = the first band of MODEL.category whose pattern matches the category
//   chain     = min(MODEL.chain_cap, 1 + home_bonus + (chains-1) x chain_extra_bonus)
//   implied   = round(base x growth x age x category x chain), at least 1
//
//   base      A protocol's TVL is the only hard number here: it is the capital that already trusts the
//             book. The float a token would put in play is a fraction of it, not all of it, so the base
//             takes a fixed share (value_share) of TVL. Without this factor the board would rank by TVL
//             and nothing else.
//   growth    A book that grew over the last seven days is a book people are moving into, which is the
//             behaviour a launch later monetises. It is clamped at both ends on purpose: a collapse is
//             not a discount to chase, and a spike is usually an incentive program that leaves, so
//             neither end is extrapolated. The weight is under 1 because momentum is a modifier on a
//             book, not a book of its own.
//   age       The protocol's age with no token is the single strongest argument it has: a book that has
//             run for years without issuing anything is a book whose team has kept the option open, and
//             whose TVL is proven rather than rented. Younger books earn less of the factor, because
//             their TVL has usually been bought with incentives and has not yet been through a drawdown.
//   category  The same TVL means different things in different businesses: a lending market earns a fee
//             on capital it can price, a DEX has the longest public record of any DeFi category, while a
//             game or a meme has thin recurring fees to attach a token to. This is where a lending book
//             outranks a yield aggregator of identical size.
//   chain     A protocol counting TVL on Ethereum, Solana or Base sits where the deepest liquidity and
//             the largest set of buyers are; each further chain is an extra surface a token can be
//             distributed on. Capped, because past a handful of chains the marginal one adds nothing.
//
// Everything is deterministic: no clock, no randomness, no ordering that depends on iteration order of a
// hash map. The same snapshot in produces the same bytes out, run after run.
//
// No protocol name is ever special-cased. One function scores every candidate of every run.

/** One protocol exactly as the sealed snapshot carries it: ten fields, no more. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** A category's band: the pattern its DefiLlama name matches, the multiplier it earns, and why. */
export interface CategoryBand {
  pattern: RegExp;
  multiplier: number;
  why: string;
}

/** Every constant the model uses, each next to the reason it holds the value it holds. */
export interface ModelConstants {
  /** The share of a protocol's TVL the model reads as the float a future token would carry. */
  value_share: number;
  /** How much of the clamped 7 day TVL change is carried into implied value: 1.0 would take it whole. */
  growth_weight: number;
  /** The lowest 7 day change the model scores, in per cent: a collapse is not a discount to chase. */
  growth_floor: number;
  /** The highest 7 day change the model scores, in per cent: a spike is usually incentives, not stickiness. */
  growth_cap: number;
  /** The age multiplier a protocol listed today earns. */
  age_floor: number;
  /** How much a protocol gains on top of the floor by reaching full age. */
  age_range: number;
  /** The age in days at which a protocol stops earning more: six years of tracked TVL with no token. */
  age_full_days: number;
  /** The age the model assumes when the snapshot carries no listed_at. */
  age_unknown_days: number;
  /** The category bands, tested in order; the first match wins. */
  category: CategoryBand[];
  /** The multiplier a category outside every band earns. */
  category_default: number;
  /** The chains whose presence earns the home bonus: the deepest liquidity and the widest buyer set. */
  chain_home: string[];
  /** The bonus for holding TVL on a chain in chain_home. */
  chain_home_bonus: number;
  /** The bonus per chain beyond the first: another surface a token could be distributed on. */
  chain_extra_bonus: number;
  /** The most the chain multipliers may come to. */
  chain_cap: number;
  /** The share of TVL that sets a farm's position size, before the wallet floor and cap. */
  position_tvl_share: number;
  /** The smallest position a plan proposes, in whole dollars: below it the gas and the clicks dominate. */
  position_floor_usd: number;
  /** The largest position a plan proposes, in whole dollars: one protocol should not take the book. */
  position_cap_usd: number;
  /** The float a launch is assumed to put in play, as a share of implied value. */
  float_share: number;
  /** How far TVL must fall below its snapshot level before a plan exits. */
  exit_drop_pct: number;
  /** How long a plan holds before it re-reads the book, in days. */
  hold_days: number;
  /** How many rows the board aims for; the watchlist is always covered in full. */
  rows_target: number;
}

export const MODEL: ModelConstants = {
  value_share: 0.22,
  growth_weight: 0.5,
  growth_floor: -40,
  growth_cap: 80,
  age_floor: 0.85,
  age_range: 0.35,
  age_full_days: 2190,
  age_unknown_days: 365,
  category: [
    { pattern: /lend/i, multiplier: 1.4, why: 'a lending book prices borrowed capital, the clearest fee a token can share' },
    { pattern: /^dex|dexs|exchange|liquidity/i, multiplier: 1.34, why: 'a DEX carries the longest public record of any DeFi category' },
    { pattern: /perp|derivative|option|basis/i, multiplier: 1.3, why: 'perps turn volume into a fee a token can claim' },
    { pattern: /cdp|stablecoin|algo/i, multiplier: 1.24, why: 'a CDP mints a stable asset a token would govern' },
    { pattern: /restak/i, multiplier: 1.22, why: 'restaking sits on yield that compounds on itself' },
    { pattern: /yield|farm|aggregat/i, multiplier: 1.16, why: 'yield products price their own future flow' },
    { pattern: /staking|stake/i, multiplier: 1.1, why: 'staking earns a fee on capital that is already locked' },
    { pattern: /curator|allocator|vault/i, multiplier: 1.08, why: 'a curator sells a track record, not a product' },
    { pattern: /rwa|real.?world/i, multiplier: 1.05, why: 'real assets bring a slower, steadier book' },
    { pattern: /bridge|cross/i, multiplier: 1.0, why: 'a bridge earns volume but splits it across every chain it serves' },
    { pattern: /gam|nft|collect|social/i, multiplier: 0.8, why: 'games and NFTs have thin recurring fees to attach a token to' },
    { pattern: /meme/i, multiplier: 0.72, why: 'a meme has no book for a token to price' },
  ],
  category_default: 0.92,
  chain_home: ['Ethereum', 'Solana', 'Base'],
  chain_home_bonus: 0.16,
  chain_extra_bonus: 0.05,
  chain_cap: 1.35,
  position_tvl_share: 2e-7,
  position_floor_usd: 25,
  position_cap_usd: 400,
  float_share: 0.2,
  exit_drop_pct: 25,
  hold_days: 90,
  rows_target: 200,
};

/** The model's label, quoted by the page and by the board's summary line. */
export const MODEL_VERSION = 'radar-3';

/** A row of board.json: one ranked protocol and every figure behind its place. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  score: number;
  model: RowModel;
  category_why: string;
  farm_steps: string[];
}

/** The multiplier chain behind one row, so the page can show each factor's contribution. */
export interface RowModel {
  base_usd: number;
  growth_pct: number;
  growth_multiplier: number;
  age_multiplier: number;
  category_multiplier: number;
  chain_multiplier: number;
  quality: number;
}

/** What data.js carries per row: everything the table renders, plus the plan and the breakdown. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  score: number;
  on_watchlist: boolean;
  category_why: string;
  model: RowModel;
  /** The row's farm plan: five numbered steps, each built from the row's own fields. */
  farm_steps: string[];
}

/** The payload of data.js: the board, the universe it was drawn from, and the model's own numbers. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: {
    value_share: number;
    growth_weight: number;
    growth_floor: number;
    growth_cap: number;
    age_floor: number;
    age_range: number;
    age_full_days: number;
    age_unknown_days: number;
    category_default: number;
    /** The bands as plain strings: a RegExp does not survive JSON, and the page only prints them. */
    category: { pattern: string; multiplier: number; why: string }[];
    chain_home: string[];
    chain_home_bonus: number;
    chain_extra_bonus: number;
    chain_cap: number;
    position_tvl_share: number;
    position_floor_usd: number;
    position_cap_usd: number;
    float_share: number;
    exit_drop_pct: number;
    hold_days: number;
    rows_target: number;
    score_ceiling: number;
  };
  universe: {
    protocols: number;
    with_token: number;
    pre_token: number;
    watchlist: number;
    ranked: number;
    below_floor: number;
  };
  rows: RadarRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else the fallback. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A non-empty string, else null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A finite number, else null. */
function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Whole days from the snapshot's as_of day to a listing day, never below zero; null when unreadable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const now = Date.parse(`${asOf}T00:00:00Z`);
  const then = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(now) || !Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now - then) / DAY_MS));
}

/** Whether the snapshot's record carries no token for a protocol: the board's whole subject. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A name ending in a version marker is another protocol's pool, not a protocol of its own. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories whose protocol is a venue rather than a launch candidate. */
const VENUE_ONLY = new Set(['CEX']);

/** A bridge or a receipt token of something that already trades is never a launch of its own. */
const NOT_A_LAUNCH = /bridge|liquid stak|restaked btc|stablecoin wrapper/i;

/**
 * Whether a pre-token protocol the watchlist leaves out may still fill a board row. An exchange's book
 * is someone else's venue, a bridge is infrastructure of a chain whose token already trades, and a
 * liquid staking wrapper is a receipt for a token that already trades, so all three stay out. Everything
 * else below the floor is a smaller protocol, not a worse subject.
 */
export function isEarlyCandidate(p: SnapshotProtocol): boolean {
  const category = p.category ?? '';
  if (VENUE_ONLY.has(category)) return false;
  if (NOT_A_LAUNCH.test(category)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  return isPreToken(p) && !VERSIONED.test(p.name);
}

/**
 * Whether a pre-token protocol is a second-tier subject: one whose only mark against it is a version
 * marker in its name. A V3 pool carries its own TVL and no token, so it is a launch candidate; it is a
 * less certain one than a protocol that is nobody's successor, so it fills the board only once every
 * first-tier candidate is already in it.
 */
export function isSecondTier(p: SnapshotProtocol): boolean {
  const category = p.category ?? '';
  if (VENUE_ONLY.has(category)) return false;
  if (NOT_A_LAUNCH.test(category)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  return isPreToken(p);
}

/** The multiplier a category earns: the first band its name matches, else the default. */
export function categoryBand(category: string | null): { multiplier: number; why: string } {
  const name = category ?? '';
  if (name.length > 0) {
    for (const band of MODEL.category) {
      if (band.pattern.test(name)) return { multiplier: band.multiplier, why: band.why };
    }
  }
  return { multiplier: MODEL.category_default, why: 'no category band matches, so it earns the default' };
}

/** The chain multiplier: a home-chain bonus, plus a little per further chain, capped. */
export function chainMultiplier(chains: string[]): number {
  const home = chains.some((c) => MODEL.chain_home.includes(c)) ? MODEL.chain_home_bonus : 0;
  const spread = Math.max(0, chains.length - 1) * MODEL.chain_extra_bonus;
  return Math.min(MODEL.chain_cap, 1 + home + spread);
}

/** The highest quality the multiplier chain could reach, used to put the score on a 0..100 scale. */
const bestCategory = MODEL.category.reduce((m, b) => Math.max(m, b.multiplier), MODEL.category_default);
export const SCORE_CEILING =
  (1 + (MODEL.growth_cap / 100) * MODEL.growth_weight) *
  (MODEL.age_floor + MODEL.age_range) *
  bestCategory *
  MODEL.chain_cap;

/** Every figure one protocol scores under the model. */
export interface Score {
  base_usd: number;
  growth_pct: number;
  growth_multiplier: number;
  age_multiplier: number;
  category_multiplier: number;
  chain_multiplier: number;
  quality: number;
  implied_value_usd: number;
  score: number;
  age_days: number | null;
  category_why: string;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One protocol's implied value and score, from its own fields and the model's constants alone. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string): Score {
  const age = ageDays(asOf, p.listed_at);
  const raw = num(p.change_7d, 0);
  const growthPct = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, raw));
  const growthMultiplier = 1 + (growthPct / 100) * MODEL.growth_weight;
  const ageUsed = Math.min(Math.max(age ?? MODEL.age_unknown_days, 0), MODEL.age_full_days);
  const ageMultiplier = MODEL.age_floor + (ageUsed / MODEL.age_full_days) * MODEL.age_range;
  const band = categoryBand(p.category);
  const chain = chainMultiplier(p.chains);
  const base = p.tvl_usd * MODEL.value_share;
  const quality = growthMultiplier * ageMultiplier * band.multiplier * chain;
  return {
    base_usd: Math.round(base),
    growth_pct: round4(growthPct),
    growth_multiplier: round4(growthMultiplier),
    age_multiplier: round4(ageMultiplier),
    category_multiplier: band.multiplier,
    chain_multiplier: round4(chain),
    quality: round4(quality),
    implied_value_usd: Math.max(1, Math.round(base * quality)),
    score: Math.min(100, Math.max(1, Math.round((quality / SCORE_CEILING) * 100))),
    age_days: age,
    category_why: band.why,
  };
}

// ---------------------------------------------------------------- the farm plan

/** A US dollar figure in the words a step can hold. */
function usd(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

/** The chain a plan names first: the one the protocol leads with, else a neutral phrase. */
function leadChain(chains: string[]): string {
  return chains.length > 0 ? chains[0]! : 'the chain its app names';
}

/** The position a protocol's own TVL argues for: a share of the book, inside a wallet floor and cap. */
export function positionSize(tvlUsd: number): number {
  const share = Math.round((tvlUsd * MODEL.position_tvl_share) / 5) * 5;
  return Math.min(MODEL.position_cap_usd, Math.max(MODEL.position_floor_usd, share));
}

/** How many times the position fits into the book: "one part in N", so the size is visibly derived. */
function partIn(tvlUsd: number, position: number): string {
  const n = Math.max(1, Math.round(tvlUsd / position));
  return `one part in ${n.toLocaleString('en-US')}`;
}

/** The venue a category asks for, in words that follow from the category alone. */
function venueFor(category: string | null, amount: number, chain: string): string {
  const c = (category ?? '').toLowerCase();
  const stake = `$${amount}`;
  if (/lend/.test(c)) {
    return `supply ${stake} of stablecoin capital to its lending market on ${chain} and hold the receipt token rather than looping it, so the whole exit is one withdrawal`;
  }
  if (/^dex|dexs|exchange|liquidity/.test(c)) {
    return `provide ${stake} as a two-sided LP position on ${chain}, in the deepest pair on the books, and claim fees weekly so an exit never waits on a lock`;
  }
  if (/perp|derivative|option|basis/.test(c)) {
    return `post ${stake} as margin on ${chain} and keep it idle rather than traded: the balance itself is what a points program scores`;
  }
  if (/cdp|stablecoin|algo/.test(c)) {
    return `open a ${stake} position against its stable asset on ${chain} at a collateral ratio above the liquidation line, and pay it back before any unlock`;
  }
  if (/restak|staking|stake/.test(c)) {
    return `stake ${stake} on ${chain} and keep the receipt token in the same wallet that staked, so the position and its proof never split`;
  }
  if (/curator|allocator|vault|yield|farm|aggregat/.test(c)) {
    return `deposit ${stake} into the protocol's own vault on ${chain}, the one that reports its fee, not a third-party wrapper that hides it`;
  }
  if (/bridge|cross/.test(c)) {
    return `bridge ${stake} onto ${chain} through the protocol itself and leave it there for the hold, so the volume and the balance both count`;
  }
  if (/rwa|real.?world/.test(c)) {
    return `mint or deposit ${stake} of the protocol's asset on ${chain} and keep the paperwork for the claim in the same wallet`;
  }
  return `deposit ${stake} into the protocol's main product on ${chain}, the pool its own dashboard leads with`;
}

/** The entry rule a 7 day change argues for: chasing a spike is the one thing the plan forbids. */
function entryFor(change: number | null): string {
  if (change === null) return 'the snapshot carries no 7 day print, so split it into three tranches a week apart';
  if (change <= -20) return 'the book is shrinking fast, so send a third now and the rest only after two flat weeks';
  if (change < 0) return 'the book is contracting, so half now and half in a week';
  if (change < 10) return 'the book is flat, so one deposit is enough';
  if (change < 40) return 'the book is warming, so split it into two tranches a week apart and let the second confirm the first';
  return 'a book this hot is usually an incentive program, so wait for a flat week before the first dollar';
}

/** The risk a category carries, in one clause. */
function riskFor(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (/lend/.test(c)) return 'bad debt if a collateral asset gaps, plus the usual smart-contract risk of a book you have not audited';
  if (/^dex|dexs|exchange|liquidity/.test(c)) return 'impermanent loss if the pair trends, on top of contract risk';
  if (/perp|derivative|option|basis/.test(c)) return 'liquidation risk on margin and oracle risk on the mark';
  if (/cdp|stablecoin|algo/.test(c)) return 'a depeg of the minted asset and a collateral auction that runs against you';
  if (/restak|staking|stake/.test(c)) return 'a slashing event and a receipt token that trades below its claim';
  if (/curator|allocator|vault|yield|farm|aggregat/.test(c)) return 'a vault whose reported yield is partly its own token, and a strategy you cannot read';
  if (/bridge|cross/.test(c)) return 'bridge risk, the one category where a bad day is total';
  return 'contract risk on a book this reader has not audited, and liquidity that may not be there on exit';
}

/** The full farm plan for one row, built only from that row's own fields. */
export function farmPlan(input: {
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  score: Score;
}): string[] {
  const amount = positionSize(input.tvl_usd);
  const chain = leadChain(input.chains);
  const tvl = usd(input.tvl_usd);
  const chains = input.chains.length > 0 ? input.chains.join(', ') : 'no chain in the record';
  const change = input.change_7d;
  const momentum =
    change === null ? 'no print' : `${change > 0 ? '+' : ''}${change.toFixed(1)}%`;
  const possible = 1 + (MODEL.growth_cap / 100) * MODEL.growth_weight;
  const exitLevel = Math.round(input.tvl_usd * (1 - MODEL.exit_drop_pct / 100));
  const float = Math.round(input.implied_value_usd * MODEL.float_share);
  const ageLine =
    input.age_days === null
      ? 'its listing date is not in the record'
      : `it has run ${input.age_days.toLocaleString('en-US')} days with no token`;

  return [
    `Size: $${amount}. The protocol holds ${tvl} of TVL, so this is ${partIn(input.tvl_usd, amount)} of the book, and it sits inside the $${MODEL.position_floor_usd}-$${MODEL.position_cap_usd} band a single wallet should risk on one name.`,
    `Venue: ${venueFor(input.category, amount, chain)}. Chains in the record: ${chains}.`,
    `Timing: 7 day TVL change ${momentum} (momentum factor x${input.score.growth_multiplier.toFixed(2)} of a possible x${possible.toFixed(2)}), and ${ageLine}. Entry rule: ${entryFor(change)}.`,
    `Risk and exit: ${riskFor(input.category)}. Exit trigger: withdraw everything if TVL prints ${MODEL.exit_drop_pct}% below its ${tvl} snapshot level, about ${usd(exitLevel)}, or after ${MODEL.hold_days} days, whichever comes first; a launch does not cancel the trigger, it starts the clock on claiming.`,
    `Float and upside: implied value ${usd(input.implied_value_usd)} at a ${Math.round(MODEL.float_share * 100)}% float puts about ${usd(float)} of new supply in play. Base case is a points or pre-token allocation sized by the hold; upside case is a launch priced at that implied value with this position counted from day one.`,
  ];
}

// ---------------------------------------------------------------- the board

/** Board rows for one protocol list, ranked by implied value, ties broken by slug. */
function rankBoard(list: SnapshotProtocol[], asOf: string, watchlist: Set<string>): BoardRow[] {
  const scored = list.map((p) => ({ p, s: scoreProtocol(p, asOf) }));
  scored.sort((a, b) => b.s.implied_value_usd - a.s.implied_value_usd || (a.p.slug < b.p.slug ? -1 : 1));
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token' as const,
    on_watchlist: watchlist.has(p.slug),
    age_days: s.age_days,
    implied_value_usd: s.implied_value_usd,
    score: s.score,
    model: {
      base_usd: s.base_usd,
      growth_pct: s.growth_pct,
      growth_multiplier: s.growth_multiplier,
      age_multiplier: s.age_multiplier,
      category_multiplier: s.category_multiplier,
      chain_multiplier: s.chain_multiplier,
      quality: s.quality,
    },
    category_why: s.category_why,
    farm_steps: farmPlan({
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: s.age_days,
      implied_value_usd: s.implied_value_usd,
      score: s,
    }),
  }));
}

/** The board and the data.js payload, from one snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();

  // The watchlist is covered in full: it is the floor of the board, never traded for a bigger row.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }

  // Then the largest early candidates below the floor, so the board reaches its target with the
  // protocols the watchlist's own size rule passed over rather than with anything arbitrary.
  const fill = Math.max(0, MODEL.rows_target - chosen.size);
  const below = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isEarlyCandidate(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, fill);
  for (const p of below) chosen.set(p.slug, p);

  // If the clean pool runs short, the board tops up with second-tier subjects: pre-token books below the
  // floor whose only mark against them is a version marker in the name. A row of that kind is still a
  // protocol with its own TVL and no token, so it earns a row; it simply never displaces a clean one.
  const short = Math.max(0, MODEL.rows_target - chosen.size);
  const second =
    short === 0
      ? []
      : snapshot.protocols
          .filter((p) => !chosen.has(p.slug) && isSecondTier(p) && p.tvl_usd < snapshot.floor_usd)
          .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
          .slice(0, short);
  for (const p of second) chosen.set(p.slug, p);

  const board = rankBoard([...chosen.values()], snapshot.as_of, watch);
  const pretoken = snapshot.protocols.filter(isPreToken).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: {
      value_share: MODEL.value_share,
      growth_weight: MODEL.growth_weight,
      growth_floor: MODEL.growth_floor,
      growth_cap: MODEL.growth_cap,
      age_floor: MODEL.age_floor,
      age_range: MODEL.age_range,
      age_full_days: MODEL.age_full_days,
      age_unknown_days: MODEL.age_unknown_days,
      category_default: MODEL.category_default,
      category: MODEL.category.map((band) => ({
        pattern: String(band.pattern),
        multiplier: band.multiplier,
        why: band.why,
      })),
      chain_home: MODEL.chain_home,
      chain_home_bonus: MODEL.chain_home_bonus,
      chain_extra_bonus: MODEL.chain_extra_bonus,
      chain_cap: MODEL.chain_cap,
      position_tvl_share: MODEL.position_tvl_share,
      position_floor_usd: MODEL.position_floor_usd,
      position_cap_usd: MODEL.position_cap_usd,
      float_share: MODEL.float_share,
      exit_drop_pct: MODEL.exit_drop_pct,
      hold_days: MODEL.hold_days,
      rows_target: MODEL.rows_target,
      score_ceiling: Math.round(SCORE_CEILING * 1000) / 1000,
    },
    universe: {
      protocols: snapshot.protocols.length,
      with_token: snapshot.protocols.length - pretoken,
      pre_token: pretoken,
      watchlist: snapshot.watchlist.length,
      ranked: board.length,
      below_floor: below.length + second.length,
    },
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      score: r.score,
      on_watchlist: r.on_watchlist,
      category_why: r.category_why,
      model: r.model,
      farm_steps: r.farm_steps,
    })),
  };
  return { board, radar };
}

/** Why the board is one the gate would refuse, or null when it is not. Empty means it passes. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length === 0) return 'the board is empty';
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100 the gate wants`;
  const seen = new Set<string>();
  for (const row of board) {
    if (seen.has(row.slug)) return `the board carries ${row.slug} twice`;
    seen.add(row.slug);
  }
  const missing = snapshot.watchlist.filter((slug) => !seen.has(slug));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug(s): ${missing.slice(0, 3).join(', ')}`;
  }
  for (const row of board) {
    const value: unknown = row.implied_value_usd;
    const whole = typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    if (!whole || (value as number) <= 0 || (value as number) > 1e14) {
      return `${row.slug} has implied value ${String(value)}, not a positive whole number under 1e14`;
    }
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug} has ${row.farm_steps.length} farm steps, outside the 3 to 12 the gate reads`;
    }
    for (const step of row.farm_steps) {
      const trimmed = step.trim();
      if (trimmed.length < 20 || trimmed.length > 600) {
        return `${row.slug} has a farm step of ${trimmed.length} characters, outside 20 to 600`;
      }
    }
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  const first = board[0]!.implied_value_usd;
  if (board.length > 1 && board.every((r) => r.implied_value_usd === first)) {
    return 'every row carries the same implied value, so the board ranks nothing';
  }
  return null;
}

/** The page's data as one script: window.RADAR holds the board, no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

/** The snapshot out of a file's text, refused unless it is the shape this model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot has no floor_usd in whole dollars');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || p.slug.length === 0) throw new SnapshotError(`protocol ${i} has no slug`);
    if (typeof p.name !== 'string' || p.name.length === 0) throw new SnapshotError(`protocol ${i} has no name`);
    if (typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} has no TVL`);
    }
    const chains = Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [];
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains,
      tvl_usd: p.tvl_usd,
      change_7d: numOrNull(p.change_7d),
      mcap_usd: numOrNull(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}
