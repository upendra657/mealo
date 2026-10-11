/**
 * A symptom's label: one name from a fixed list, beside the person's words.
 *
 * The words are the record. The label is what the app can count by: "bloated
 * and gassy since lunch" and "tummy feels tight again" are two different
 * strings and one thing to count. Both were tried alone on 22 realistic
 * entries (11 Oct 2026). Words alone give the app nothing to group. A label
 * alone lost every trigger and detail ("after eating prawns", "when I stand
 * up", "for 3 days"), and the keyword matcher mislabelled two of the 22. So
 * the app suggests, the person corrects on the card, and both are kept.
 *
 * A label is never forced (Upendra's decision): a symptom nothing here fits
 * is logged in its own words, and counted by nothing until it has a label.
 *
 * Pure: no database and no clock, so the list and the matcher are tested in
 * node with the rest of the plain logic.
 */

import { scrubContacts } from '../safety/deidentify';

/**
 * The list, in the order the sheet shows it.
 *
 * Not from a published classification. It is everyday wording for what gets
 * written in a food and medicine diary, checked by Upendra against his own
 * use, and it grows the same way.
 *
 * The wording of a label is its identity: `symptoms.label` stores these exact
 * strings. Rewording one later would split its history in two, the same
 * reason a medicine's name is never edited in place. Add a label, or retire
 * one from this list; do not rename.
 */
export const SYMPTOM_GROUPS: readonly { group: string; labels: readonly string[] }[] = [
  {
    group: 'Stomach',
    labels: ['Bloating', 'Gas', 'Acidity', 'Indigestion', 'Nausea', 'Vomiting', 'Stomach pain', 'Loose motion', 'Constipation', 'Low appetite'],
  },
  { group: 'Head', labels: ['Headache', 'Migraine', 'Dizziness'] },
  {
    group: 'Nose, throat and chest',
    labels: ['Cough', 'Cold', 'Blocked nose', 'Sore throat', 'Breathlessness', 'Wheezing', 'Chest pain', 'Palpitations'],
  },
  { group: 'Whole body', labels: ['Fever', 'Chills', 'Tiredness', 'Weakness', 'Body ache', 'Swelling'] },
  { group: 'Skin', labels: ['Rash', 'Itching', 'Acne'] },
  { group: 'Aches', labels: ['Back pain', 'Neck pain', 'Joint pain', 'Muscle cramp', 'Toothache', 'Period pain'] },
  { group: 'Eyes, ears and mouth', labels: ['Eye strain', 'Ear pain', 'Mouth ulcer'] },
  { group: 'Urinary', labels: ['Painful urination', 'Frequent urination'] },
  { group: 'Sleep and mood', labels: ['Poor sleep', 'Low mood', 'Anxiety', 'Stress'] },
];

export const SYMPTOM_LABELS: readonly string[] = SYMPTOM_GROUPS.flatMap((g) => g.labels);

/**
 * What suggests each label. Lower-case text, whole words.
 *
 * Every pattern starts on a word boundary, and that is the fix for a real
 * miss: "eyelid keeps twitching" was labelled Itching by a matcher that
 * looked for "itch" anywhere.
 *
 * The romanised Hindi is here because that is how a symptom gets typed on a
 * phone in India ("sir dard", "pet mein dard"). Devanagari is not matched;
 * such an entry is logged in its own words, with no label suggested.
 *
 * "Cold" needs its article ("have a cold", "caught a bad cold"). Bare, it is
 * also the weather, the water and the coffee.
 */
const HINTS: readonly [label: string, patterns: readonly RegExp[]][] = [
  ['Bloating', [/\bbloat(?:ed|ing)?\b/, /\bpet ph[ou]ol/]],
  ['Gas', [/\bgass?y\b/, /\bgas\b/, /\bflatulen/, /\bburp/, /\bfart/]],
  ['Acidity', [/\bacidity\b/, /\bheart ?burn\b/, /\b(?:acid )?reflux\b/, /\bkhatt[ie] dakar/]],
  ['Indigestion', [/\bindigestion\b/, /\bbadhazmi\b/]],
  ['Nausea', [/\bnause(?:a|ous|ated)\b/, /\bqueasy\b/, /\bfeel(?:ing|s)? like (?:throwing up|vomiting|puking)\b/, /\bj[ei]e? m[ai]ch?la/]],
  ['Vomiting', [/\bvomit/, /\bthrew up\b/, /\bthrowing up\b/, /\bpuk(?:ed|ing)\b/, /\bulti\b/]],
  [
    'Stomach pain',
    [
      /\b(?:stomach|tummy|abdominal|abdomen|belly)[ -]?(?:aches?|pain|cramps?)\b/,
      /\bpain in (?:my |the )?(?:stomach|tummy|abdomen|belly)\b/,
      /\b(?:stomach|tummy|belly) (?:is )?(?:hurting|hurts)\b/,
      /\bpet (?:mein |me )?dard\b/,
    ],
  ],
  ['Loose motion', [/\bloose (?:motions?|stools?)\b/, /\bdiarrh?o?ea\b/, /\bthe runs\b/, /\bdast\b/]],
  ['Constipation', [/\bconstipat/, /\bkabz\b/]],
  ['Low appetite', [/\b(?:no|low|poor|lost my|loss of) appetite\b/, /\bnot (?:feeling )?hungry\b/, /\bbh[ou]o?kh nahi/]],

  ['Migraine', [/\bmigraine\b/]],
  ['Headache', [/\bhead ?aches?\b/, /\bhead (?:is )?(?:hurting|hurts|pounding|throbbing)\b/, /\bs[ai]r+ ?dard\b/]],
  ['Dizziness', [/\bdizz(?:y|iness)\b/, /\blight[ -]?headed\b/, /\bvertigo\b/, /\bgidd(?:y|iness)\b/, /\bchakkar\b/]],

  ['Cough', [/\bcough(?:s|ing)?\b/, /\bkhans?i\b/]],
  [
    'Cold',
    [
      /\b(?:have|having|has|got|caught|with) a (?:bad |head |slight |mild )?cold\b/,
      /\bcommon cold\b/,
      /\bcold and (?:cough|fever)\b/,
      /\b(?:cough|fever) and cold\b/,
      /\brunn(?:y|ing) nose\b/,
      /\bsneez/,
      /\b[zj]ukh?aa?m\b/,
      /\bsardi\b/,
    ],
  ],
  ['Blocked nose', [/\b(?:blocked|stuffy|stuffed|congested) nose\b/, /\bnose (?:is )?(?:blocked|stuffy|stuffed)\b/, /\bnasal congestion\b/, /\bnaak band\b/]],
  [
    'Sore throat',
    [/\b(?:sore|scratchy) throat\b/, /\bthroat (?:is )?(?:sore|scratchy|hurting|hurts|pain|ache)\b/, /\bgal[ae] (?:mein |me )?(?:kharab|dard|kharash)\b/],
  ],
  [
    'Breathlessness',
    [
      /\bbreathless/,
      /\bshort(?:ness)? of breath\b/,
      /\bout of breath\b/,
      /\b(?:can'?t|cannot|hard to|difficulty|difficult to|trouble|struggling to) breath(?:e|ing)\b/,
      /\bsaans (?:nahi|ph[ou]ol|lene)/,
    ],
  ],
  ['Wheezing', [/\bwheez/]],
  ['Chest pain', [/\bchest (?:pain|pressure|tight(?:ness)?)\b/, /\bpain in (?:my |the )?chest\b/, /\b(?:seene|chh?ati) (?:mein |me )?dard\b/]],
  ['Palpitations', [/\bpalpitat/, /\bheart (?:is )?(?:racing|pounding|fluttering)\b/, /\bracing heart\b/]],

  ['Fever', [/\bfever(?:ish)?\b/, /\b(?:high|running a) temperature\b/, /\bbukh?aa?r\b/]],
  ['Chills', [/\bchills\b/, /\bshiver/]],
  ['Tiredness', [/\btired(?:ness)?\b/, /\bfatigued?\b/, /\bexhaust(?:ed|ion)\b/, /\b(?:no|low on|low) energy\b/, /\bletharg/, /\bthak(?:an|aan|awat)\b/]],
  ['Weakness', [/\bweak(?:ness)?\b/, /\bkamzori\b/]],
  ['Body ache', [/\bbody ?(?:aches?|pain)\b/, /\bach(?:y|ing) all over\b/, /\bbadan (?:mein |me )?dard\b/]],
  ['Swelling', [/\bswell(?:ing)?\b/, /\bswollen\b/, /\bso?[ou]jan\b/]],

  ['Rash', [/\brash(?:es)?\b/, /\bhives\b/]],
  ['Itching', [/\bitch(?:y|ing|es)?\b/, /\bkhujli\b/]],
  ['Acne', [/\bacne\b/, /\bpimples?\b/, /\bbreak ?outs?\b/]],

  ['Back pain', [/\bback ?(?:pain|ache)\b/, /\bback (?:is )?(?:hurting|hurts|sore|stiff)\b/, /\bkamar (?:mein |me )?dard\b/]],
  ['Neck pain', [/\bneck ?(?:pain|ache)\b/, /\bstiff neck\b/, /\bneck (?:is )?(?:hurting|hurts|sore|stiff)\b/]],
  [
    'Joint pain',
    [
      /\bjoint ?(?:pains?|aches?)\b/,
      /\bjoints? (?:are |is )?(?:hurting|aching|sore|stiff)\b/,
      /\b(?:knee|elbow|wrist|ankle|shoulder|hip)s? (?:pain|ache|is hurting|are hurting|hurts?)\b/,
      /\bghutn(?:e|o|on) (?:mein |me )?dard\b/,
    ],
  ],
  ['Muscle cramp', [/\b(?:muscle|leg|calf|foot) cramps?\b/, /\bcramps? in (?:my )?(?:leg|calf|foot|thigh)s?\b/, /\bmuscle (?:pain|pull|soreness)\b/, /\bsore muscles\b/]],
  ['Toothache', [/\btooth ?ache\b/, /\b(?:tooth|teeth|gums?) (?:pain|is hurting|are hurting|hurts?)\b/, /\bdaant (?:mein |me )?dard\b/]],
  ['Period pain', [/\b(?:period|menstrual) (?:pain|cramps?)\b/, /\bcramps? (?:from|during|before) (?:my )?periods?\b/]],

  ['Eye strain', [/\beye ?strain\b/, /\b(?:tired|strained|sore|burning|dry) eyes?\b/, /\beyes? (?:are |is )?(?:burning|hurting|tired|sore|strained|dry)\b/]],
  ['Ear pain', [/\bear ?(?:ache|pain)\b/, /\bear (?:is )?(?:hurting|hurts)\b/, /\bkaan (?:mein |me )?dard\b/]],
  ['Mouth ulcer', [/\b(?:mouth|tongue) ulcers?\b/, /\bulcers? (?:in|on) (?:my )?(?:mouth|tongue)\b/, /\bcanker sores?\b/, /\bmu[nh]h? (?:mein |me )?chh?aal/]],

  ['Painful urination', [/\b(?:burning|painful|pain|stinging)\b[a-z ]{0,24}\b(?:pee|peeing|urine|urinat\w*)\b/, /\bpeshab (?:mein |me )?jalan\b/]],
  [
    'Frequent urination',
    [/\b(?:frequent|constant) (?:urination|urinating|peeing)\b/, /\b(?:pee|peeing|urinat\w+) (?:a lot|too often|frequently|again and again|every)\b/, /\bbaar baar peshab\b/],
  ],

  [
    'Poor sleep',
    [
      /\b(?:can'?t|cannot|couldn'?t|could not|unable to|trouble|hard to) (?:fall(?:ing)? a)?sleep(?:ing)?\b/,
      /\binsomnia\b/,
      /\b(?:poor|bad|broken|no|little|disturbed) sleep\b/,
      /\b(?:slept|sleeping) (?:badly|poorly)\b/,
      /\b(?:did ?n[o']t|didnt|hardly|barely) (?:sleep|slept)\b/,
      /\bn[ei]e?nd nahi/,
    ],
  ],
  ['Low mood', [/\blow mood\b/, /\b(?:feel|feeling|felt) (?:very |so |really )?(?:low|down|sad|depressed)\b/, /\bdepress(?:ed|ion)\b/, /\budaas\b/]],
  ['Anxiety', [/\banxi(?:ety|ous)\b/, /\bpanic(?:ky| attack)?\b/, /\bnervous(?:ness)?\b/, /\bghabra/]],
  ['Stress', [/\bstress(?:ed)?\b/, /\boverwhelmed\b/]],
];

/**
 * "no fever", "not dizzy", "without any cough": the word is there and the
 * symptom is not. Only the few words straight before a match are read; a
 * longer reach starts cancelling the wrong half of "no fever but a cough".
 */
const DENIED = /\b(?:no|not|without|never|nahi|nahin)\s+(?:a |an |any |much |really |feeling )?$/;

/**
 * The label these words most likely mean, or null.
 *
 * When several match, the one named first in the text wins: people lead with
 * what bothers them most ("headache, and a bit of nausea"). A tie goes to
 * the earlier entry in HINTS.
 *
 * It reads words, not meaning. "My partner has a cough" suggests Cough for
 * the wrong person, and that is why the card shows the label before
 * anything is saved and lets it be changed or removed.
 */
export function suggestLabel(text: string): string | null {
  const t = text.toLowerCase();
  let best: { label: string; at: number } | null = null;
  for (const [label, patterns] of HINTS) {
    for (const p of patterns) {
      for (const m of t.matchAll(new RegExp(p.source, 'g'))) {
        if (DENIED.test(t.slice(0, m.index))) continue;
        if (!best || m.index < best.at) best = { label, at: m.index };
        break;
      }
    }
  }
  return best?.label ?? null;
}

/**
 * How much of a symptom's words a model is sent.
 *
 * 200 is Upendra's number (11 Oct 2026), "in case user wants to go in
 * detail". It was 60, cut wherever the count ran out, and 4 of 22 test
 * entries went out ending mid-sentence.
 */
export const WORDS_FOR_MODEL = 200;

/** "Dr. Rao" is not the end of a sentence. */
const TITLE = /\b(?:dr|mr|mrs|ms|st)\.$/i;

/**
 * A symptom's words as they leave the phone: phone numbers and email
 * addresses taken out, and no longer than `max`, ending where a sentence
 * ends.
 *
 * Scrubbed before it is cut, so a cut can never leave half a phone number
 * that no longer looks like one.
 *
 * Words with no sentence end inside the limit are cut at the last whole
 * word and marked with an ellipsis, so the reader is told there was more.
 */
export function wordsForModel(raw: string, max = WORDS_FOR_MODEL): string {
  const text = scrubContacts(raw.trim().replace(/\s+/g, ' ')).text;
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let end = -1;
  for (const m of head.matchAll(/[.!?\u0964](?=\s|$)/g)) {
    const stop = m.index + 1;
    // A full stop on the very last character kept only ends a sentence if
    // the text goes on with a space; otherwise it is the dot in "38.5".
    if (stop === max && /\S/.test(text.charAt(max))) continue;
    if (!TITLE.test(head.slice(0, stop))) end = stop;
  }
  if (end > 0) return head.slice(0, end);
  const space = head.lastIndexOf(' ');
  return `${head.slice(0, space > 0 ? space : max).replace(/[,;:]$/, '')}…`;
}
