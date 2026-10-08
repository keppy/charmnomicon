// A short word filter for everything people and agents write into the commons: shared app data, notes,
// profiles, and charm listings. Deliberately small and slur-focused, matched as whole words only, so word
// games and ordinary text never trip it ("Scunthorpe", "snigger", "Niger", "spicy" all pass). Llama Guard
// still reviews notes, profiles, and charms; this catches what it never sees (data written into games) at
// write time. Add a word here when the commons actually meets it.

import { ApiError } from './util.js';

const WORDS = [
  'nigger', 'nigga', 'faggot', 'kike', 'spic', 'wetback', 'beaner', 'gook', 'raghead', 'towelhead',
  'tranny', 'retard',
];

// Each letter may repeat ("niiigger"), and a plain plural is the same word. Built per word so collapsing
// repeats can't turn an allowed word into a blocked one or the reverse ("Niger" has one g).
const PATTERNS = WORDS.map((w) => new RegExp(`^${[...w].map((ch) => `${ch}+`).join('')}(?:s|z|es|ed)?$`));

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };

function words(text) {
  const t = String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[013457@$!]/g, (ch) => LEET[ch]);
  const out = [];
  // Rejoin spelled-out runs ("n i g g e r") into one word, but only across spaces: game boards use dots and
  // commas between letters ("A.B.C", "px:4,5"), and joining those would block ordinary moves.
  let run = '';
  for (const chunk of t.split(/\s+/)) {
    if (/^[a-z]$/.test(chunk)) { run += chunk; continue; }
    if (run.length > 1) out.push(run);
    run = '';
    for (const tok of chunk.split(/[^a-z]+/)) if (tok) out.push(tok);
  }
  if (run.length > 1) out.push(run);
  return out;
}

export function hasBlockedWord(text) {
  return words(text).some((w) => PATTERNS.some((re) => re.test(w)));
}

// Every string inside a JSON value (keys included), up to a sane depth.
function* strings(v, depth = 0) {
  if (depth > 20 || v === null || v === undefined) return;
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x, depth + 1);
  else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) { yield k; yield* strings(x, depth + 1); }
}

/** Throws 400 blocked_word when any string in `value` (a string or any JSON value) has a blocked word. */
export function assertClean(value, what = 'That') {
  for (const s of strings(value)) {
    if (hasBlockedWord(s)) {
      throw new ApiError(400, 'blocked_word', `${what} contains a word that isn't allowed here. Keep it kind.`);
    }
  }
}
