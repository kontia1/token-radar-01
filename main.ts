// The token radar's entrypoint: Node 22, the standard library only, no network, no dependencies.
//
//   node --experimental-strip-types main.ts --input <snapshot.json|directory> [--output <dir>]
//
// It reads the sealed snapshot, scores every protocol that records no token with lib/model.ts, and
// writes, into the output directory (--output, else MAKEFUN_OUTPUT_DIR, else /output):
//
//   board.json      {"rows": [...]}  the ranked board, one row per protocol, 3 to 12 farm steps each
//   data.js         window.RADAR = {...}  the same board, for the page to render with no fetch
//   dashboard/      a copy of this repository's dashboard/ (index.html, app.css, app.js)
//   screenshots/    a copy of this repository's screenshots/ (three images: board, detail, filtered)
//   dossier.json    what the judge reads, written by buildDossier from vendor/makefun-board.ts
//
// The program is deterministic: it reads no clock, takes no random number and walks no unordered map,
// so two runs over the same snapshot write the same bytes. It exits non-zero when it cannot write a
// board the gate would accept, rather than handing in a board that fails.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boardIssue,
  buildRadar,
  dataScript,
  isPreToken,
  MODEL,
  MODEL_VERSION,
  parseSnapshot,
  SnapshotError,
  type Snapshot,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The text cap the judge reads the page's source under. */
const TEXT_MAX_BYTES = 65_536;
/** The gate's board caps: rows, bytes, each row's implied value. */
const BOARD_MIN_ROWS = 100;
const BOARD_MAX_ROWS = 4_000;
const BOARD_MAX_BYTES = 8 * 1024 * 1024;
const IMPLIED_MAX_USD = 1e14;
/** The gate's screenshot caps: count, bytes, and the pixel box each image must fit. */
const SHOT_MIN = 3;
const SHOT_MAX = 4;
const SHOT_MAX_BYTES = 512 * 1024;
const SHOT_LONG_SIDE = 1440;
const SHOT_SHORT_SIDE = 800;
/** The gate's dossier cap. */
const DOSSIER_MAX_BYTES = 1.5 * 1024 * 1024;
/** A screenshot's name: a letter, digit or _ first, then letters, digits and . _ -. */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> or --name=value out of the arguments, else the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const equals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return equals === undefined ? fallback : equals.slice(name.length + 3);
}

/** A byte count in the words a summary line can hold. */
function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const fail = (line: string): never => {
  process.stderr.write(`token radar: ${line}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------- input

/** --input may name the snapshot file itself or the directory that holds it. */
const inputArg = arg('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? resolve(inputArg) : resolve(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  process.stderr.write(`token radar: no snapshot at ${snapshotPath}\n`);
  process.stderr.write('token radar: pass --input <snapshot.json|directory>, or mount the sealed /input\n');
  process.exit(2);
}

const out = resolve(arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output'));

let snapshot: Snapshot;
try {
  snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
} catch (err) {
  if (err instanceof SnapshotError) fail(`${snapshotPath}: ${err.message}`);
  throw err;
}

// ---------------------------------------------------------------- the board

let built: ReturnType<typeof buildRadar>;
try {
  built = buildRadar(snapshot);
} catch (err) {
  if (err instanceof SnapshotError) fail(`${snapshotPath}: ${err.message}`);
  throw err;
}
const { board, radar, calibration } = built;
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`refusing the board this model wrote: ${issue}`);

mkdirSync(out, { recursive: true });

const boardText = `${JSON.stringify({ model_version: MODEL_VERSION, as_of: snapshot.as_of, rows: board }, null, 0)}\n`;
writeFileSync(join(out, 'board.json'), boardText);
writeFileSync(join(out, 'data.js'), dataScript(radar));

// ---------------------------------------------------------------- the page and its images

/** Copy a directory's regular, non-dot files into `to`, creating it; returns the names copied. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyDir(join(here, 'dashboard'), join(out, 'dashboard'));
if (!dashFiles.includes('index.html') || !dashFiles.some((n) => n.endsWith('.css')) || !dashFiles.some((n) => n.endsWith('.js'))) {
  fail('dashboard/ needs index.html plus at least one .css and one .js: the page is what the judge reads');
}

const shots = copyDir(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length}: hand in three at least (board, detail, filtered)`);
for (const name of shots) {
  if (!PLAIN_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, up to 128 of them`);
}

// ---------------------------------------------------------------- the dossier

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES }));

// ---------------------------------------------------------------- the output check

/** A PNG or JPEG's pixel box from its header, or null when the bytes are neither whole format. */
function imageBox(bytes: Buffer): { media: 'image/png' | 'image/jpeg'; width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes.subarray(1, 8).toString('latin1') === 'PNG\r\n\x1a\n' &&
    bytes.subarray(12, 16).toString('latin1') === 'IHDR'
  ) {
    return { media: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1]!;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const length = bytes.readUInt16BE(at + 2);
      if (length < 2) break;
      const startOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (startOfFrame && at + 8 < bytes.length) {
        return { media: 'image/jpeg', height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      }
      at += 2 + length;
    }
  }
  return null;
}

/**
 * The gate's checks, run on what this program just wrote. The program refuses to hand in output it has
 * not read back: the board's rows, ranks, slugs, implied values and farm steps; the watchlist coverage;
 * the data.js payload; each screenshot's format, size and pixel box; and the dossier byte for byte
 * against a fresh buildDossier of the same directory. Returns every issue it found, not just the first.
 */
function verifyOutput(dir: string, snap: Snapshot): string[] {
  const issues: string[] = [];
  const add = (message: string): void => {
    if (issues.length < 10) issues.push(message);
  };
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));

  // board.json
  let boardRows: unknown[] = [];
  try {
    const path = join(dir, 'board.json');
    const size = statSync(path).size;
    if (size > BOARD_MAX_BYTES) add(`board.json is ${size} bytes, over the ${BOARD_MAX_BYTES} the gate reads`);
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(raw)) boardRows = raw;
    else if (typeof raw === 'object' && raw !== null && Array.isArray((raw as { rows?: unknown }).rows)) {
      boardRows = (raw as { rows: unknown[] }).rows;
    } else add('board.json is not an object whose rows is an array');
  } catch (err) {
    add(`board.json cannot be read: ${(err as Error).message}`);
  }
  if (boardRows.length < BOARD_MIN_ROWS || boardRows.length > BOARD_MAX_ROWS) {
    add(`board.json holds ${boardRows.length} rows, outside ${BOARD_MIN_ROWS} to ${BOARD_MAX_ROWS}`);
  }

  const seen = new Set<string>();
  const ranks: number[] = [];
  const values: number[] = [];
  let last = Infinity;
  for (let i = 0; i < boardRows.length; i++) {
    const row = boardRows[i] as Record<string, unknown> | null;
    if (typeof row !== 'object' || row === null) {
      add(`board row ${i + 1} is not an object`);
      continue;
    }
    const slug = row.slug;
    if (typeof slug !== 'string' || slug.length === 0 || slug.length > 128 || /\s/.test(slug)) {
      add(`board row ${i + 1} has no slug the gate reads`);
      continue;
    }
    if (seen.has(slug)) add(`${slug} appears twice`);
    seen.add(slug);
    const p = bySlug.get(slug);
    if (p === undefined) add(`${slug} is not a protocol the snapshot carries`);
    else if (!isPreToken(p)) add(`${slug} already carries a token and is not a launch to rank`);
    if (typeof row.name !== 'string' || row.name.length === 0) add(`${slug} has no name`);
    const rank = row.rank;
    if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1) add(`${slug} has no positive whole rank`);
    else ranks.push(rank);
    const value = row.implied_value_usd;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > IMPLIED_MAX_USD) {
      add(`${slug} has no positive whole implied value under ${IMPLIED_MAX_USD}`);
    } else {
      values.push(value);
      if (value > last) add(`implied value rises at row ${i + 1}`);
      last = value;
    }
    const steps = row.farm_steps;
    if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12) {
      add(`${slug} has ${Array.isArray(steps) ? steps.length : 'no'} farm steps, outside 3 to 12`);
    } else {
      for (const step of steps) {
        const text = typeof step === 'string' ? step.trim() : '';
        if (text.length < 20 || text.length > 600) add(`${slug} has a farm step of ${text.length} characters`);
      }
    }
  }
  ranks.sort((a, b) => a - b);
  if (ranks.length !== boardRows.length || ranks.some((r, i) => r !== i + 1)) {
    add('the ranks are not exactly 1 to N once each');
  }
  if (values.length > 1 && values.every((v) => v === values[0])) add('every row carries the same implied value');
  const missing = snap.watchlist.filter((slug) => !seen.has(slug));
  if (missing.length > 0) add(`the watchlist is missing ${missing.length} slug(s): ${missing.slice(0, 3).join(', ')}`);

  // data.js
  try {
    const text = readFileSync(join(dir, 'data.js'), 'utf8');
    const prefix = 'window.RADAR = ';
    if (!text.startsWith(prefix) || !text.endsWith(';\n')) {
      add('data.js is not the window.RADAR script the page loads');
    } else {
      const payload = JSON.parse(text.slice(prefix.length, -2)) as {
        model_version?: unknown;
        rows?: unknown;
        universe?: { ranked?: unknown };
      };
      if (payload.model_version !== MODEL_VERSION) add(`data.js names model ${String(payload.model_version)}, not ${MODEL_VERSION}`);
      if (!Array.isArray(payload.rows) || payload.rows.length !== boardRows.length) {
        add('data.js rows do not match board.json rows');
      }
      if (typeof payload.universe !== 'object' || payload.universe === null || payload.universe.ranked !== boardRows.length) {
        add('data.js universe.ranked does not match the board');
      }
    }
  } catch (err) {
    add(`data.js cannot be read: ${(err as Error).message}`);
  }

  // dashboard/ and screenshots/
  for (const name of ['index.html', 'app.css', 'app.js']) {
    if (!existsSync(join(dir, 'dashboard', name))) add(`dashboard/${name} is missing from the output`);
  }
  let shotNames: string[] = [];
  try {
    shotNames = readdirSync(join(dir, 'screenshots'), { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    add(`screenshots/ cannot be read: ${(err as Error).message}`);
  }
  if (shotNames.length < SHOT_MIN || shotNames.length > SHOT_MAX) {
    add(`screenshots/ holds ${shotNames.length} images, outside ${SHOT_MIN} to ${SHOT_MAX}`);
  }
  for (const name of shotNames) {
    if (!PLAIN_NAME.test(name)) add(`screenshots/${name} is not a name a dossier reads`);
    try {
      const bytes = readFileSync(join(dir, 'screenshots', name));
      if (bytes.length > SHOT_MAX_BYTES) add(`screenshots/${name} is ${bytes.length} bytes, over ${SHOT_MAX_BYTES}`);
      const box = imageBox(bytes);
      if (box === null) add(`screenshots/${name} is neither a whole PNG nor a JPEG`);
      else {
        const long = Math.max(box.width, box.height);
        const short = Math.min(box.width, box.height);
        if (long > SHOT_LONG_SIDE || short < SHOT_SHORT_SIDE) {
          add(`screenshots/${name} is ${box.width}x${box.height}, outside the 1440x800 box the gate reads`);
        }
      }
    } catch (err) {
      add(`screenshots/${name} cannot be read: ${(err as Error).message}`);
    }
  }

  // dossier.json, byte for byte against a fresh build
  const dossierPath = join(dir, 'dossier.json');
  try {
    const bytes = readFileSync(dossierPath);
    if (bytes.length > DOSSIER_MAX_BYTES) add(`dossier.json is ${bytes.length} bytes, over ${DOSSIER_MAX_BYTES}`);
    try {
      const rebuilt = buildDossier(dir, { text_max_bytes: TEXT_MAX_BYTES });
      if (!bytes.equals(Buffer.from(rebuilt))) add('dossier.json is not byte-for-byte what buildDossier writes for this output');
    } catch (err) {
      add(`buildDossier refuses this output: ${(err as Error).message}`);
    }
    const doc = JSON.parse(bytes.toString('utf8')) as {
      schema?: unknown;
      text?: unknown;
      images?: unknown;
    };
    if (doc.schema !== 'makefun/dossier/v1') add(`dossier.json names schema ${String(doc.schema)}`);
    if (typeof doc.text !== 'string') add('dossier.json has no text');
    else if (/\[Cut at \d+ bytes|lines not shown/.test(doc.text)) {
      add('the dossier text cuts the dashboard source: keep it under the 65,536 byte cap');
    }
    if (!Array.isArray(doc.images) || doc.images.length !== shotNames.length) {
      add('the dossier images do not match screenshots/');
    }
  } catch (err) {
    add(`dossier.json cannot be read: ${(err as Error).message}`);
  }

  return issues;
}

const outputIssues = verifyOutput(out, snapshot);
if (outputIssues.length > 0) {
  for (const message of outputIssues) process.stderr.write(`token radar: output check: ${message}\n`);
  fail(`the written output fails the gate check (${outputIssues.length} issue(s))`);
}

// ---------------------------------------------------------------- the summary

const top = board[0]!;
const last = board[board.length - 1]!;
const watched = board.filter((r) => r.on_watchlist).length;
const usd = (n: number): string => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`);

say(`token radar ${MODEL_VERSION} · snapshot ${snapshot.as_of}`);
say(
  `  input    ${snapshotPath} (${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, floor $${(snapshot.floor_usd / 1e6).toFixed(0)}M)`,
);
say(
  `  universe ${radar.universe.pre_token} record no token, ${radar.universe.with_token} already carry one and are not ranked`,
);
say(
  `  board    ${board.length} rows: ${watched} from the watchlist, ${radar.universe.outside_watchlist} outside it (${radar.universe.below_floor} below the floor, ${radar.universe.second_tier} versioned second-tier; target ${MODEL.rows_target}, the clean pool stops at ${board.length})`,
);
say(`  value    ${top.name} ${usd(top.implied_value_usd)} at rank 1, ${last.name} ${usd(last.implied_value_usd)} at rank ${last.rank}`);
say(
  calibration.basis === 'snapshot-median'
    ? `  base     ${calibration.share} of TVL: the median mcap/TVL of ${calibration.sample} token-bearing protocols (raw median ${calibration.median}, prior ${calibration.prior})`
    : `  base     ${calibration.share} of TVL: the model prior (only ${calibration.sample} token-bearing protocols to calibrate from)`,
);
say(`  model    implied = tvl x ${calibration.share} x momentum x age x category x chain, ${board[0]!.farm_steps.length} farm steps a row`);
say(`  output   ${out}`);
say(
  `  files    board.json ${kb(Buffer.byteLength(boardText))} · data.js ${kb(statSync(join(out, 'data.js')).size)} · dossier.json ${kb(statSync(join(out, 'dossier.json')).size)} · dashboard/ ${dashFiles.length} · screenshots/ ${shots.length}`,
);
say(`  checked  board, data.js, ${shots.length} screenshots and the dossier re-read and byte-compared`);
