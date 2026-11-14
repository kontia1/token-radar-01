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
import { boardIssue, buildRadar, dataScript, MODEL, MODEL_VERSION, parseSnapshot, SnapshotError } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The text cap the judge reads the page's source under. */
const TEXT_MAX_BYTES = 65_536;
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

let snapshot;
try {
  snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
} catch (err) {
  if (err instanceof SnapshotError) fail(`${snapshotPath}: ${err.message}`);
  throw err;
}

// ---------------------------------------------------------------- the board

const { board, radar } = buildRadar(snapshot);
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
  `  board    ${board.length} rows: ${watched} from the watchlist, ${radar.universe.below_floor} below the floor (target ${MODEL.rows_target}, the clean pool stops at ${board.length})`,
);
say(`  value    ${top.name} ${usd(top.implied_value_usd)} at rank 1, ${last.name} ${usd(last.implied_value_usd)} at rank ${last.rank}`);
say(`  model    implied = tvl x ${MODEL.value_share} x momentum x age x category x chain, ${board[0]!.farm_steps.length} farm steps a row`);
say(`  output   ${out}`);
say(
  `  files    board.json ${kb(Buffer.byteLength(boardText))} · data.js ${kb(statSync(join(out, 'data.js')).size)} · dossier.json ${kb(statSync(join(out, 'dossier.json')).size)} · dashboard/ ${dashFiles.length} · screenshots/ ${shots.length}`,
);
