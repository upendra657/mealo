/**
 * Requirement R7, and the two gates beside it: what Ask Mealo will not take
 * to a model at all.
 *
 * R1 (redflags.ts) stops emergencies. These stop the things a model should
 * never be the one to answer, however well it might: disordered eating and
 * extreme goals, changing a medicine, and being asked for a diagnosis. Each
 * ends the turn in plain code with a fixed message that points to a person
 * who can help, and gives no answer of its own.
 *
 * Why code and not an instruction to the model. Anyone can clone this app and
 * plug in any model with any key. An instruction is a request; a model can be
 * argued out of it, role-played around it, or simply be a model that does not
 * follow instructions well. A pattern that returns before `fetch` is called
 * cannot be talked round, and the test suite can prove it stopped.
 *
 * Like R1, these lean towards stopping. A needless "talk to a dietitian"
 * costs a moment. An answer that coaches someone further into restriction
 * costs what the app exists to protect. The exception is deliberate and
 * tested as hard as the stops: ordinary life must get through. "Skipped
 * breakfast", "lose 5 kg in 3 months", "I eat between 12 and 8" and "did I
 * miss any doses this week?" are not emergencies, and a gate that fires on
 * them is a gate people learn to distrust.
 *
 * ---------------------------------------------------------------------------
 * Where the numbers come from
 * ---------------------------------------------------------------------------
 *
 * No threshold here was chosen by feel. Each was read in its source on
 * 11 Oct 2026 and approved by Upendra the same day:
 *
 *   1000 kcal a day   "Weight reduction diets should not be less than 1000
 *                     Kcal/day and provide all nutrients." ICMR-NIN, Dietary
 *                     Guidelines for Indians, 2nd edition (2011), Guideline 8.
 *                     One number for everyone, which matters because this app
 *                     stores no sex, age or height.
 *
 *   1.5 kg a week     "rates of weight loss should not exceed an average of
 *                     1.5 kg per week": Weinsier, Wilson, Lee. Am J Med
 *                     1995;98(2):115-7, on gallstone risk. Guidelines
 *                     recommend 0.5 to 1 kg (NHS, NIH, CDC); 1.5 is where a
 *                     demonstrated harm begins, so it is where the gate does.
 *
 *   4 weeks           The span the weight signal is judged over. The
 *                     Weinsier analysis used studies of at least 4 weeks; and
 *                     the first week or two of any change in diet is largely
 *                     water. Upendra lost 5 kg in 2 weeks and is not the
 *                     person this is for.
 *
 *   1 kg a week gain  Not a harm threshold, and not presented as one. No
 *                     source read gives a rate of gain above which harm is
 *                     shown. It is the highest rate any source suggests
 *                     (Larson-Meyer et al., review of weight gain advice),
 *                     so a typed goal beyond it is beyond all of them. The
 *                     weight record alone never stops anyone for gaining.
 *
 *   A fast over 24 h  The app's own line, labelled as such. ICMR-NIN says
 *                     "Severe fasting may lead to health hazards" and gives
 *                     no duration. Intermittent fasting inside a day is
 *                     allowed (Upendra, 11 Oct); a fast that runs past a day
 *                     is not planned here.
 *
 * The floor is applied to the calorie TARGET, never to what was logged. A
 * low logged day is nearly always a meal that was not entered: his own week
 * read 581 kcal a day over two half-logged days.
 *
 * No helpline number is shown. None has been verified for any country, and
 * a wrong number in this message is worse than none.
 */

export type GateId =
  | 'eating'
  | 'low-calories'
  | 'fast-goal'
  | 'long-fast'
  | 'low-target'
  | 'fast-loss'
  | 'medicine-change'
  | 'diagnosis'
  | 'nothing-tracked';

export type Stop = { gate: GateId; title: string; message: string };

/** What the gate reads beside the words: two facts from the person's own record. */
export type Signals = {
  /** The daily calorie target they set, or null. */
  calorieTarget: number | null;
  /** Logged weights, any order. */
  weights: readonly { at: number; kg: number }[];
};

export const CALORIE_FLOOR = 1000;
export const MAX_LOSS_KG_PER_WEEK = 1.5;
export const MAX_GAIN_KG_PER_WEEK = 1;
export const SIGNAL_WEEKS = 4;
export const MAX_FAST_HOURS = 24;

const WHO = 'a doctor or a registered dietitian';

/**
 * The words shown, one fixed text per gate.
 *
 * Fixed for two reasons. A message with a number worked into it is a message
 * that can be made to say something untrue; and the chat tells an app-written
 * stop from a model's answer, when it is opened again, by matching these
 * exact strings (`stopOfMessage`). Reword one and stops saved under the old
 * wording read back as AI answers, so do not reword casually.
 */
export const STOPS: Record<GateId, { title: string; message: string }> = {
  eating: {
    title: 'This is one for a person, not an app',
    message:
      `Ask Mealo does not answer this. What you describe is worth talking through with ${WHO}, in person and soon. ` +
      'If food, eating or how you feel about your body is weighing on you, please tell someone you trust today.',
  },
  'low-calories': {
    title: 'Below what is safe to plan here',
    message:
      `Ask Mealo does not help with eating under ${CALORIE_FLOOR.toLocaleString('en-US')} kcal a day. ` +
      'A weight reduction diet should not go below that (ICMR-NIN, Dietary Guidelines for Indians). ' +
      `Anything lower needs ${WHO} who knows you.`,
  },
  'fast-goal': {
    title: 'Too fast to plan here',
    message:
      'Ask Mealo does not help with a change in weight this fast. ' +
      `Losing more than about ${MAX_LOSS_KG_PER_WEEK} kg a week carries real risk, gallstones among them (Weinsier et al., Am J Med 1995), ` +
      `and no guidance reviewed suggests gaining faster than about ${MAX_GAIN_KG_PER_WEEK} kg a week. ` +
      `A goal like this needs ${WHO} who knows you.`,
  },
  'long-fast': {
    title: 'Not a fast to plan here',
    message:
      'Ask Mealo does not help plan a fast longer than a day, or one without water. ' +
      'Severe fasting may lead to health hazards (ICMR-NIN, Dietary Guidelines for Indians). ' +
      `Please speak to ${WHO} before a fast like this.`,
  },
  'low-target': {
    title: 'Your calorie target is very low',
    message:
      `Your daily calorie target is set below ${CALORIE_FLOOR.toLocaleString('en-US')} kcal, so Ask Mealo is not answering questions about food or weight. ` +
      'A weight reduction diet should not go below that (ICMR-NIN, Dietary Guidelines for Indians). ' +
      `Please talk to ${WHO}. You can change the target in Targets at any time.`,
  },
  'fast-loss': {
    title: 'Your weight is falling fast',
    message:
      `Your logged weight has fallen faster than ${MAX_LOSS_KG_PER_WEEK} kg a week for ${SIGNAL_WEEKS} weeks or more, so Ask Mealo is not answering questions about food or weight. ` +
      'Loss at that rate carries real risk, gallstones among them (Weinsier et al., Am J Med 1995). ' +
      `Please see ${WHO}, and a doctor soon if you are not trying to lose weight.`,
  },
  'medicine-change': {
    title: 'Ask whoever prescribed it',
    message:
      'Ask Mealo does not answer whether to stop, skip, swap or change the amount of a medicine. ' +
      'That is for the doctor who prescribed it, or a pharmacist. Please ask them before changing anything.',
  },
  diagnosis: {
    title: 'Ask Mealo does not diagnose',
    message:
      'Ask Mealo cannot tell you whether you have a condition. It can show you what you have tracked: meals, medicines, weight and symptoms, and what turns up together. ' +
      'For what it is, please see a doctor. A report of your records can go with you: Generate a report.',
  },
  'nothing-tracked': {
    title: 'Nothing tracked yet',
    message:
      'Ask Mealo works from your own records, and there is nothing in them yet. ' +
      'Log a few meals, your medicines or a symptom, then ask again.',
  },
};

const stop = (gate: GateId): Stop => ({ gate, ...STOPS[gate] });

/** The gate a stored reply came from, or null if it is not one of these texts. */
export function stopOfMessage(content: string): Stop | null {
  for (const id of Object.keys(STOPS) as GateId[]) {
    if (STOPS[id].message === content) return stop(id);
  }
  return null;
}

/** Lower case, straight quotes, single spaces: what every pattern below reads. */
function norm(input: string): string {
  return input
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ----------------------------------------------------- disordered eating

/**
 * Purging, restriction, misuse of laxatives and the like, exercise as
 * punishment, and distress about the body.
 *
 * Each entry is a behaviour, not a word. "starving" alone is somebody who
 * wants lunch; "starve myself" is not. "laxative" alone may be about
 * constipation; with weight in the same breath it is not.
 */
const EATING: readonly RegExp[] = [
  // Purging.
  /\b(?:make|making|made|makes) (?:myself|me) (?:sick|throw up|vomit|puke)\b/,
  /\b(?:force|forcing|forced|induce|inducing|induced) (?:myself to )?(?:vomit|throw up|puke)/,
  /\bself[- ]?induced vomit/,
  /\bpurg(?:e|es|ed|ing)\b/,
  /\bfingers? down (?:my |the )?throat\b/,
  /\b(?:throw|throwing|threw) (?:it |everything |my (?:food|meal|dinner|lunch) )?up (?:after|so (?:that )?i|to (?:lose|stay|get|not))/,
  /\bvomit(?:ing)? (?:after (?:eating|meals?|every)|to (?:lose|stay|get|keep|not))/,
  /\bbinge and purge\b/,
  /\bbing(?:e|es|ed|eing|ing)\b.{0,30}\b(?:throw up|threw up|vomit|purge|puke)/,
  /\bchew(?:ing)? and spit/,
  /\bkhan[ae] ke baad ulti kar/,
  /\bulti kar(?:ke|na|ne|u|un|oon|ta|ti)\b.{0,40}\b(?:wazan|wajan|vajan|weight|patl[ai]|motap)/,

  // Restriction.
  /\bstarv(?:e|ing|ed) (?:myself|my ?self|my body)\b/,
  /\bstarvation diet\b/,
  /\b(?:least|minimum|fewest|lowest|bare minimum) (?:amount )?(?:i|you|one|a person|someone) (?:can|could|need to|have to|should) eat\b/,
  /\bhow little can (?:i|you|one|a person) eat\b/,
  /\b(?:haven'?t|have not|havent|hadn'?t|didn'?t|did not|not) (?:eaten|eat|eating|had (?:any )?food)\b.{0,20}\b(?:in|for) (?:\d+|two|three|four|five|six|a few|several|many|do|teen|char) (?:days?|din)\b/,
  // Hiding it is the part that says what it is.
  /\bhid(?:e|ing)\b.{0,30}\b(?:not eating|my eating|that i (?:don'?t|dont|do not) eat|skipping meals|my food|vomiting|purging|throwing up)/,
  /\b(?:not eating|skip(?:ping)? meals?|throw(?:ing)? up|purging)\b.{0,30}\b(?:without|so that|so) (?:my |anyone|anybody|people|nobody|no one|parents|mom|mum|family|husband|wife).{0,20}(?:know|notic|find|see)/,
  /\b(?:eat|eating|ate) (?:absolutely |literally )?nothing\b/,
  /\b(?:not|stop|stopped|stopping|quit|quitting|avoid|avoiding) eat(?:ing)?(?: at all| anything| altogether| completely| entirely| food)\b/,
  // "Stopped eating", full stop. "Stopped eating sugar" and "stop eating at
  // 8 pm" are a change of habit and an eating window, and both are fine.
  /\b(?:stop|stopped|stopping|quit|quitting) eating(?:$|\s*[.?!,;]|\s+(?:for (?:a|an|\d+|two|three|a few|some) (?:day|days|week|weeks|while)|until|till|to (?:lose|get|be|stay)))/,
  /\bhow (?:long|many days|many weeks) can (?:i|a person|someone|you|one) (?:go|survive|last|live) without (?:eating|food)\b/,
  /\b(?:zero|no|0) calories? (?:a|per|each|every) day\b/,
  /\b(?:survive|live|living|surviving) (?:only |just )?on (?:only |just )?(?:water|black coffee|coffee|tea|air|ice|gum|nothing)\b/,
  /\bkhana (?:band|chh?od)\b/,
  /\bbh[ou]o?kh[aei] reh(?:kar|ke|na|u|un|oon)\b/,
  /\bkuch (?:bhi )?(?:nahi|nahin|na) kha(?:na|u|un|oon|ta|ti|ungi|unga)\b/,

  // Laxatives, diuretics, pills, in the service of weight.
  /\b(?:laxatives?|diuretics?|water pills?|enemas?|julab)\b.{0,60}\b(?:weight|wazan|wajan|lose|losing|slim|thin|skinny|fat|calorie|after (?:eating|meals?|dinner|lunch|a binge))/,
  /\b(?:weight|wazan|wajan|lose|losing|slim|thin|skinny|calorie|after (?:eating|meals?|a binge))\b.{0,60}\b(?:laxatives?|diuretics?|water pills?|enemas?|julab)\b/,
  /\b(?:\d+|several|many|lots of|a handful of|handfuls of) laxatives\b/,
  /\blaxatives? (?:every|each|a|per) day\b|\blaxatives? daily\b/,
  /\bdiet pills?\b/,
  /\bappetite suppress/,
  /\bfat burners?\b.{0,40}\b(?:without eating|instead of (?:eating|food|meals?))/,

  // Exercise as payment or punishment.
  /\b(?:burn|work|run|exercise|sweat) (?:it|that|this|them|everything|the calories|those calories) off\b.{0,50}\b(?:ate|eaten|eating|meal|binge|cheat|dessert|calories)/,
  /\b(?:ate|eaten|eating|meal|binge|binged|cheat(?:ed)?|dessert)\b.{0,50}\b(?:burn|work|run|exercise|sweat) (?:it|that|this|them|everything) off\b/,
  /\b(?:exercise|work ?out|run|gym|train|cardio)\w* (?:to|until i|till i|so i) (?:make up for|compensate|earn|deserve|punish|undo)/,
  /\bpunish(?:ing)? (?:myself|my body)\b/,
  /\b(?:earn|deserve|earned|deserved) (?:my |the |a |to (?:eat|have) )?(?:food|meal|meals|dinner|lunch|breakfast|eat)\b/,
  /\bexercis\w+ (?:for )?(?:\d+|three|four|five|six) hours? (?:a|every|per|each) day\b/,

  // Distress about the body, and fear of food.
  /\bi (?:hate|loathe|despise|can'?t stand|cannot stand|am disgusted by|'?m disgusted by) (?:my (?:body|stomach|belly|thighs|arms|face|weight|self)|myself|how i look)\b/,
  /\bi(?:'?m| am| feel| look) (?:so |too |really |very |just )?(?:disgusting|gross|repulsive|worthless)\b/,
  /\bi(?:'?m| am| feel) (?:so |too |really )(?:fat|huge|ugly)\b/,
  /\b(?:feel|feeling|felt) (?:so |really |very )?guilty (?:after|about|for|when) (?:i )?(?:eat|eating|ate|food|every meal|meals)/,
  /\b(?:scared|afraid|terrified|frightened|petrified) (?:of|to) (?:eat|eating|food|gain|gaining|put on|putting on)\b/,
  /\bcan'?t stop (?:thinking about|counting) (?:food|calories|my weight|eating)\b/,
  /\b(?:lost|losing|lose) control (?:when|while|around|with) (?:i )?(?:eat|eating|food)\b/,
  /\b(?:don'?t|do not) deserve to eat\b/,

  // Named, and the communities that promote it.
  /\banorexi/,
  /\bbulimi/,
  /\bpro[- ]?(?:ana|mia)\b/,
  /\bthinsp(?:o|iration)/,
  /\bbinge[- ]eating disorder\b/,
  /\beating disorder\b/,
];

// ------------------------------------------------------------- numbers

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, che: 6, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
  half: 0.5, couple: 2,
};
const COUNT = `(\\d+(?:\\.\\d+)?|${Object.keys(WORD_NUMBERS).join('|')})`;
const toNumber = (s: string | undefined): number => (s == null ? 1 : (WORD_NUMBERS[s] ?? Number(s)));

/** Weeks in each period a goal is stated over. A month is 365.25 / 12 / 7. */
const WEEKS: Record<string, number> = {
  day: 1 / 7, days: 1 / 7, din: 1 / 7, dino: 1 / 7,
  week: 1, weeks: 1, wk: 1, wks: 1, hafta: 1, hafte: 1, hafton: 1,
  fortnight: 2,
  month: 4.348, months: 4.348, mahina: 4.348, mahine: 4.348, mahino: 4.348,
  year: 52.18, years: 52.18, saal: 52.18,
  // "by friday", "by this weekend", "by tomorrow": within the week at most.
  // Read as a full week, the most lenient reading there is; a goal that is
  // too fast even so is too fast.
  weekend: 1, tomorrow: 1, monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1,
};
const PERIOD = `(${Object.keys(WEEKS).join('|')})`;
const KG_PER: Record<string, number> = {
  kg: 1, kgs: 1, kilo: 1, kilos: 1, kilogram: 1, kilograms: 1, kilogramme: 1, kilogrammes: 1,
  lb: 0.4536, lbs: 0.4536, pound: 0.4536, pounds: 0.4536,
  stone: 6.35, stones: 6.35,
};
const MASS = `(${Object.keys(KG_PER).join('|')})`;

const LOSE = '(?:lose|losing|loose|loosing|drop|dropping|shed|shedding|cut|cutting|reduce|reducing|burn|burning|get rid of|take off|kam|ghata\\w*)';
const GAIN = '(?:gain|gaining|put on|putting on|add|adding|bulk|bulking|pack on|badha\\w*)';

/**
 * A goal stated as an amount over a time: "lose 10 kg in a month", "2 kg a
 * week", "20 pounds in 2 weeks", "10 kilo ek mahine mein kam".
 *
 * Only goals. "I lost 5 kg in 2 weeks" is a report of what happened, and the
 * past tense is not in the verb lists on purpose: the person it describes is
 * the one who should be able to ask about it.
 */
export function goalRate(input: string): { direction: 'lose' | 'gain'; kgPerWeek: number } | null {
  const t = norm(input);
  const join = '(?:in|within|over|by|per|a|an|each|every|inside|under|for)';
  const filler = '(?:the |just |only |about |around |roughly |next |coming |this |under |less than )*';
  const english = new RegExp(
    `\\b(${LOSE}|${GAIN})\\b[^.?!]{0,30}?(\\d+(?:\\.\\d+)?)\\s*${MASS}\\b[^.?!]{0,25}?\\b${join}\\s+${filler}(?:${COUNT}\\s+)?${PERIOD}\\b`,
  );
  const e = english.exec(t);
  if (e) {
    const kg = Number(e[2]) * KG_PER[e[3]];
    const weeks = toNumber(e[4]) * WEEKS[e[5]];
    return { direction: new RegExp(`^${GAIN}$`).test(e[1]) ? 'gain' : 'lose', kgPerWeek: kg / weeks };
  }
  // Hindi word order: the amount, then the time, then the verb.
  const hindi = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*${MASS}\\b[^.?!]{0,30}?(?:${COUNT}\\s+)?${PERIOD}\\b[^.?!]{0,20}?\\b(kam|ghata\\w*|badha\\w*)`,
  ).exec(t) ?? new RegExp(
    `(?:${COUNT}\\s+)?${PERIOD}\\b[^.?!]{0,20}?(\\d+(?:\\.\\d+)?)\\s*${MASS}\\b[^.?!]{0,20}?\\b(kam|ghata\\w*|badha\\w*)`,
  ).exec(t);
  if (hindi) {
    // The two orders put the groups in different places; read them by kind.
    const groups = hindi.slice(1);
    const mass = groups.find((g) => g != null && g in KG_PER)!;
    const period = groups.find((g) => g != null && g in WEEKS)!;
    const amount = Number(groups[groups.indexOf(mass) - 1]);
    const count = groups[groups.indexOf(period) - 1];
    const verb = groups[groups.length - 1]!;
    const weeks = toNumber(count ?? undefined) * WEEKS[period];
    return { direction: verb.startsWith('badha') ? 'gain' : 'lose', kgPerWeek: (amount * KG_PER[mass]) / weeks };
  }
  return null;
}

/** "lose weight fast", "crash diet": a rate nobody stated and everybody means. */
const FAST_WORDS: readonly RegExp[] = [
  /\bcrash diet/,
  /\b(?:lose|losing|drop|shed) (?:all )?(?:this |my |the |some )?(?:weight|fat|belly fat|belly|kilos|pounds)\b[^.?!]{0,20}\b(?:fast|quick|quickly|asap|rapidly|overnight|immediately|urgently|instantly)\b/,
  /\b(?:fastest|quickest) way to (?:lose|drop|shed|gain)\b/,
  /\b(?:lose|drop|shed) (?:weight|fat|belly fat)\b[^.?!]{0,10}\bin (?:a|one|two|three|\d) (?:day|days)\b/,
  /\brapid weight loss\b/,
  /\bjaldi (?:se )?(?:wazan|wajan|vajan|weight|motapa) (?:kam|ghata)/,
  /\b(?:wazan|wajan|vajan|weight|motapa) jaldi (?:se )?(?:kam|ghata)/,
];

/**
 * A number of calories given as what to eat in a day.
 *
 * Returns the lowest such number, or null. Three things that look like it
 * and are not: a deficit ("500 calorie deficit"), a single meal ("my lunch
 * was 450 calories"), and what was burned ("burned 300 calories").
 */
export function dailyCalories(input: string): number | null {
  const t = norm(input);
  const daily = /\b(?:a day|per day|each day|every day|daily|\/ ?day|a din|roz|rozana|diet|per din|din (?:mein|me|ka|ki)|all day|whole day|for the day)\b/.test(t);
  let lowest: number | null = null;
  const re = /(?:^|[^\d.,])(\d{2,4})\s*(?:k?cals?|kilocalories|calories?)\b(?!\s*(?:deficit|less|fewer|lower|below (?:my|maintenance)|under (?:my|maintenance)|more|extra|surplus|over (?:my|maintenance)|above))/g;
  for (const m of t.matchAll(re)) {
    const before = t.slice(Math.max(0, m.index - 40), m.index + 1);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 30);
    // Taken away or burned: an amount, but not an amount eaten.
    if (/\b(?:burn|burned|burnt|burning|burns|deficit of|cut|cutting|cut out|reduce|reduced|reduce by|reducing|drop|dropping|remove|minus|save|saved|saving)\s*(?:by |about |around |only |just )*$/.test(before)) continue;
    // "a 600 kcal meal plan" is a day's eating; "i only eat 400 cal" is a
    // habit, said in the present tense, with or without the word "day".
    const planned = /^\s*(?:meal |diet |eating |food )?plan\b/.test(after) || /\b(?:i|we) (?:only|just|barely|hardly) (?:eat|have|consume|take in)\s*(?:about |around )?$/.test(before);
    // One snack or one meal of that size, however often it is eaten.
    if (!planned && /^\s*(?:snack|breakfast|lunch|dinner|meal|dessert|drink|smoothie|shake|bar|treat|portion|serving|bowl|plate|roti|paratha|samosa)/.test(after)) continue;
    const said = planned || /^\s*(?:a|per|each|every|\/)\s*(?:day|din)|^\s*(?:daily|diet|roz)/.test(after);
    // "is 800 calories a day enough" says the day itself. Without that, a
    // day mentioned elsewhere only counts when the number is not a
    // description of something eaten ("lunch was 450 calories").
    if (!said && (!daily || /\b(?:was|were|had|has|have|contains?|is|are|worth|of)\s*(?:about |around |only |just )*$/.test(before))) continue;
    const n = Number(m[1]);
    if (lowest == null || n < lowest) lowest = n;
  }
  return lowest;
}

// ----------------------------------------------------------- fasting

/**
 * Fasts that are an observance, not a diet: eating goes on each day, in a
 * different pattern. Not stopped for their length. A fast "with no water"
 * or "eating nothing" is still caught, by the lines that say so.
 */
const OBSERVANCE = /\b(?:navratri|navratra|ramadan|ramzan|ramazan|roza|rozay|lent|ekadashi|karva ?chauth|karwa ?chauth|shravan|sawan|saawan|paryushan|vrat|upvas|upwas|yom kippur|maha ?shivratri|shivratri|janmashtami|chhath)\b/;

/**
 * Hours a fast is said to last, or null when no length is given.
 *
 * "16:8", "18/6" and "OMAD" are eating patterns inside a day and give no
 * length here. So does "5:2": its two low days are caught by the calorie
 * floor if a number under it is asked for, not by this.
 */
export function fastHours(input: string): number | null {
  const t = norm(input);
  if (!/\b(?:fast|fasts|fasting|fasted|upvas|upwas|vrat|bhookha|without (?:eating|food))\b/.test(t)) return null;
  // How often is not how long. "2 days a week", "once every 3 days" and
  // "16 hours a day" all carry a number and a unit, and none is a duration,
  // so they are taken out before durations are read.
  const habit = /\b(?:a|per|every|each) day\b|\bdaily\b|\bintermittent\b|\b\d{1,2} ?[:/] ?\d\b/.test(t);
  const s = t
    // "for a week" is a length; "twice a week" is not. Kept when "for" or
    // the like stands in front.
    .replace(/\b(for|of|over|lasting|last)?\s*\b(?:(?:once|twice|thrice|\d+ times?|\d+ days?|one day|two days|three days)\s+)?(?:a|per|every|each)\s+(?:week|month|fortnight|day)\b/g,
      (whole, length) => (length ? whole : ' '))
    .replace(/\b(?:every|each|per)\s+(?:\d+|other|second|third|few|couple of)?\s*(?:days?|weeks?|months?)\b/g, ' ');
  let longest: number | null = null;
  const take = (h: number) => {
    if (longest == null || h > longest) longest = h;
  };
  for (const m of s.matchAll(new RegExp(`\\b${COUNT}\\s*[- ]?(hours?|hrs?|h|ghante|ghanta|days?|din|dino|weeks?|wks?|hafte|hafta|months?|mahine|mahina)\\b`, 'g'))) {
    const n = toNumber(m[1]);
    const unit = m[2];
    if (/^(?:hours?|hrs?|h|ghante|ghanta)$/.test(unit)) take(n);
    else if (/^(?:days?|din|dino)$/.test(unit)) take(n * 24);
    // "fasting 16 hours a day for 2 weeks", "intermittent fasting for 6
    // weeks": the weeks are how long the habit has run, not one fast.
    else if (habit) continue;
    else if (/^(?:weeks?|wks?|hafte|hafta)$/.test(unit)) take(n * 24 * 7);
    else take(n * 24 * 30);
  }
  return longest;
}

const FAST_ALWAYS: readonly RegExp[] = [
  /\bdry fast/,
  /\b(?:fast|fasting|fasted)\b.{0,40}\b(?:no|without|zero) (?:water|fluids?|liquids?)\b/,
  /\b(?:no|without|zero) (?:water|fluids?|liquids?)\b.{0,40}\b(?:fast|fasting)\b/,
  /\bnirjala\b.{0,40}\b(?:\d+|two|three|four|five|do|teen|char) (?:days?|din)\b/,
  /\b(?:prolonged|extended|multi[- ]?day|long[- ]term|week[- ]long|month[- ]long) (?:water )?fast/,
  /\bwater[- ]?(?:only )?fast(?:ing)?\b(?!.{0,30}\b(?:\d+|a|one|few) hours?\b)/,
  /\bfast(?:ing)? (?:until|till) (?:i|my) (?:lose|reach|hit|drop|am|weigh)/,
  /\bfast(?:ing)? (?:to|as) (?:punish|make up|compensat)/,
  // Days "without eating", whatever the fast is called.
  /\b(?:\d+|do|teen|char|chaar|paanch|two|three|four|five) (?:din|days?)\b.{0,25}\bbina (?:kha|pani|paani)/,
];

// ------------------------------------------------- changing a medicine

const MED = '(?:medicine|medicines|medication|medications|meds|med|tablet|tablets|pill|pills|capsule|capsules|dose|doses|dosage|insulin|injection|injections|inhaler|antibiotics?|statins?|steroids?|antidepressants?|blood thinners?|vitamins?|supplements?|bp (?:medicine|tablet|pill)s?|thyroid (?:medicine|tablet|pill)s?|sugar (?:medicine|tablet|pill)s?|metformin|syrup|drops|course|prescription|treatment|drug|drugs|dawa|dawai|dawaiyan|goli|goliyan|\\d+ ?mg)';

/**
 * Asking, or announcing, as opposed to looking back. "Did I miss any doses
 * this week?" is a question about the record and must reach the model;
 * "can I skip tonight's dose?" must not.
 */
const INTENT = new RegExp(
  [
    "\\b(?:can|could|should|shall|may|must|might|would it be ok if|is it ok if|what if|suppose) (?:i|we|he|she|you|my \\w+)\\b",
    "\\bis it (?:ok|okay|safe|fine|alright|all right|bad|dangerous|harmful|a problem)\\b",
    "\\b(?:ok|okay|safe|fine|alright) (?:to|if)\\b",
    "\\bwhat (?:happens|would happen|will happen) if\\b",
    "\\bdo i (?:need|have|really need|still need) to\\b",
    "\\bi (?:want|wanna|need|plan|intend|decided|have decided|would like|wish|am going|am planning|am thinking|feel like|might|may|will|shall)\\b",
    "\\bi'?(?:m|ll|d like to) (?:going|gonna|planning|thinking|about to)?\\b",
    "\\b(?:going to|gonna|thinking (?:of|about)|planning (?:to|on)|about to|tempted to|feel like)\\b",
    "\\bhow (?:do|can|should|to|long|soon|quickly|safely)\\b",
    "\\bwhen (?:can|should|do|may) i\\b",
    "\\blet me\\b",
    "\\b(?:doctor|dr|doc|physician|nurse|pharmacist|chemist|friend|mom|mum|mother|father|dad|wife|husband|google|internet|chatgpt) (?:said|says|told|suggested|thinks|recommended)\\b",
    "\\btold me (?:i can|to|it'?s|that)\\b",
    "\\bwithout (?:asking|telling|consulting|checking with)\\b",
    "\\bany (?:harm|problem|issue|risk|side effects?) (?:in|if|with)\\b",
    "\\b(?:safe|okay|ok|fine)\\?",
    "\\bhelp me\\b",
    "\\btell me (?:how|if|whether|when)\\b",
  ].join('|'),
);

const CHANGE: readonly RegExp[] = [
  new RegExp(`\\b(?:stop|stopping|quit|quitting|discontinue|discontinuing|ditch|drop|dropping|give up|giving up|come off|coming off|get off|getting off|go off|going off|wean(?:ing)?(?: myself)? off|taper(?:ing)?(?: off)?|pause|pausing|take a break from|skip|skipping|miss|missing|leave|leaving|leave out|leaving out|avoid|avoiding)\\b[^.?!]{0,45}\\b${MED}\\b`),
  new RegExp(`\\b(?:not|don'?t|dont|do not|never|without) tak(?:e|ing)\\b[^.?!]{0,25}\\b${MED}\\b`),
  // A medicine by its brand name is not in any list here; the count gives it away.
  /\btake (?:two|2|three|3|four|4|both|double|a couple)\b[^.?!]{0,30}\b(?:at once|together|at the same time|in one go|at a time)\b/,
  new RegExp(`\\b${MED}\\b[^.?!]{0,30}\\b(?:stop|stopping|quit|discontinue|skip|skipping|pause|taper|wean)\\b`),
  new RegExp(`\\b(?:double|doubling|doubled|triple|halve|halving|half|increase|increasing|raise|raising|up|upping|reduce|reducing|lower|lowering|cut|cutting|cut down|decrease|decreasing|adjust|adjusting|change|changing|modify|split|splitting|crush|crushing|break|breaking)\\b[^.?!]{0,35}\\b${MED}\\b`),
  new RegExp(`\\b${MED}\\b[^.?!]{0,25}\\b(?:double|twice|two at once|both together|half|halve|more often|less often|every other day|alternate days?)\\b`),
  new RegExp(`\\btake (?:an? )?(?:extra|additional|another|second|two|2|three|3|double|more|less|fewer|half)\\b[^.?!]{0,25}\\b${MED}\\b`),
  new RegExp(`\\btake (?:two|2|both|double|more|extra)\\b[^.?!]{0,25}\\b(?:to make up|to catch up|instead of one|since i missed|because i missed)`),
  new RegExp(`\\b(?:switch|switching|swap|swapping|replace|replacing|substitute|substituting|change|changing|move|moving)\\b[^.?!]{0,35}\\b(?:${MED}|brand|generic)\\b`),
  new RegExp(`\\b(?:instead of|in place of|rather than)\\b[^.?!]{0,25}\\b${MED}\\b`),
];

/** A dose already missed, and what to do about it now: the answer is a dose. */
const MISSED_NOW = new RegExp(
  `\\b(?:missed|forgot|forgotten|skipped|didn'?t take|did not take|haven'?t taken)\\b[^.?!]{0,40}\\b${MED}\\b[^]*\\b(?:what (?:should|do|now|can)|should i|can i|do i|shall i|take (?:it|two|2|both|double|one|them) now|now\\?|catch up|make up)\\b`,
);

const MED_HINGLISH: readonly RegExp[] = [
  /\b(?:dawa|dawai|dawaiyan|goli|goliyan|tablet|medicine|dose|insulin)\b.{0,30}\b(?:band|chh?od|rok|skip|double|dugn[ai]|aadh[ai]|adh[ai]|kam|zyada|jyada|badha|badal|nahi l(?:u|un|oon|ena|eni))\w*.{0,20}\b(?:kar|kr|du|dun|doon|sakt[aei]|chaht[aei]|chahiye|lu|lun|loon|karna|karni|karu|karun|karoon|dena|deni|\?)/,
  /\b(?:band|chh?od|rok|skip|double|dugn[ai]|aadh[ai]|adh[ai]|kam|zyada|jyada|badha|badal)\w*\b.{0,20}\b(?:dawa|dawai|goli|tablet|medicine|dose|insulin)\b.{0,25}\b(?:kar|kr|du|dun|doon|sakt[aei]|chaht[aei]|chahiye|lu|lun|loon|karna|karu|\?)/,
];

// ------------------------------------------------------------ diagnosis

const CONDITION = '(?:diabet\\w*|pre[- ]?diabet\\w*|cancer|tumou?r|thyroid\\w*|hypothyroid\\w*|pcos|pcod|ibs|ibd|ulcers?|infection|covid|corona|flu|dengue|malaria|typhoid|tb|tuberculosis|an(?:a)?emi\\w*|arthritis|asthma|depress\\w+|anxiety disorder|adhd|autism|heart (?:disease|attack|problem|condition|failure)|kidney (?:disease|stones?|problem|failure)|liver (?:disease|problem|failure)|fatty liver|jaundice|hernia|appendi\\w+|gall ?stones?|migraines?|c(?:o)?eliac|crohn\\w*|gerd|acid reflux disease|hypertension|high bp|high blood pressure|low bp|cholesterol problem|allerg\\w+|lactose intoleran\\w+|gluten intoleran\\w+|food intoleran\\w+|(?:vitamin|iron|b12|d3?) deficien\\w+|deficien\\w+|a disease|a disorder|a syndrome|a condition|an illness|an infection|something serious|something wrong|bimari|rog)';

/** The same list, for the report's AI insights: a point that names one of these is dropped. */
export const CONDITION_WORDS = CONDITION;

const DIAGNOSIS: readonly RegExp[] = [
  /\bdiagnos(?:e|ing) (?:me|my|this|it|what)\b/,
  /\b(?:can|could|will|would) you (?:please )?diagnos/,
  /\b(?:give|tell) me (?:a|my|the) diagnosis\b/,
  /\bwhat(?:'?s| is) (?:my|the) diagnosis\b/,
  /\bwhat(?:'?s| is) wrong with me\b/,
  /\bwhat (?:disease|illness|condition|disorder|sickness|bimari) (?:do i have|is this|is it|could (?:this|it) be|might (?:this|it) be|have i got)\b/,
  new RegExp(`\\b(?:do i|did i|could i|might i|can i|would i|i might|i may|i could|i probably|think i|if i|whether i|i must|i definitely) (?:have|be having|be getting|possibly have|might have|may have|could have)\\b[^.?!]{0,20}\\b${CONDITION}\\b`),
  new RegExp(`\\b(?:could|can|might|may|is|are|would) (?:my|this|these|the|that) [a-z' ]{2,30}?\\b(?:be|a sign of|signs of|a symptom of|symptoms of|due to|because of|caused by|from)\\b[^.?!]{0,15}\\b${CONDITION}\\b`),
  /\bwhat (?:do|does|could|might|would) (?:my|these|this|the) (?:symptoms?|signs?) (?:mean|indicate|point to|suggest|tell)/,
  new RegExp(`\\b(?:is (?:this|it|that)|could (?:this|it|that) be|might (?:this|it|that) be|can (?:this|it) be|does this (?:mean|look like|sound like)|are these (?:signs?|symptoms?) of|is this a (?:sign|symptom) of|sign of|symptoms? of)\\b[^.?!]{0,25}\\b${CONDITION}\\b`),
  new RegExp(`\\bam i\\b[^.?!]{0,12}\\b(?:diabetic|pre[- ]?diabetic|an(?:a)?emic|depressed|allergic|lactose intolerant|gluten intolerant|c(?:o)?eliac|hypothyroid|asthmatic|sick with)\\b`),
  new RegExp(`\\b(?:mujhe|mujhko|mere ko|kya mujhe)\\b[^.?!]{0,25}\\b${CONDITION}\\b[^.?!]{0,12}\\b(?:hai|ho gaya|ho gayi|to nahi)\\b`),
];

// --------------------------------------------- when the record says so

/**
 * Questions about food and weight. With a signal from the record, these are
 * what is stopped, and nothing else: someone whose weight is falling fast
 * can still ask which doses are left.
 */
const FOOD_OR_WEIGHT = /\b(?:eat|eating|ate|eaten|food|foods|meal|meals|diet|dieting|calorie|calories|kcal|cal|weight|weigh|weighed|kg|kilo|kilos|fat|slim|slimmer|thin|thinner|lose|losing|loss|lost|gain|gaining|bulk|cut|cutting|fast|fasting|protein|carb|carbs|macro|macros|portion|portions|plan|target|targets|deficit|hungry|hunger|appetite|bmi|breakfast|lunch|dinner|snack|snacks|khana|wazan|wajan)\b/;

/**
 * Kilograms a week the logged weight has been falling, over the most recent
 * span of at least `SIGNAL_WEEKS`, or null when the record cannot say.
 *
 * The latest reading is compared with the one nearest to four weeks before
 * it. Shorter than four weeks proves nothing, and that is the point of the
 * span: water goes first. Longer than six and the comparison is no longer
 * about now. With no reading in that window there is no signal, never a
 * guess from whatever readings there are.
 */
export function lossRate(weights: Signals['weights'], now = Date.now()): number | null {
  const day = 86_400_000;
  const sorted = [...weights].filter((w) => w.kg > 0).sort((a, b) => a.at - b.at);
  const latest = sorted[sorted.length - 1];
  // A reading from last month says nothing about what is happening this week.
  if (!latest || now - latest.at > 10 * day) return null;
  const min = SIGNAL_WEEKS * 7 * day;
  const max = (SIGNAL_WEEKS + 2) * 7 * day;
  let base: { at: number; kg: number } | null = null;
  for (const w of sorted) {
    const span = latest.at - w.at;
    if (span < min || span > max) continue;
    if (!base || span < latest.at - base.at) base = w;
  }
  if (!base) return null;
  return (base.kg - latest.kg) / ((latest.at - base.at) / (7 * day));
}

// --------------------------------------------------------------- the gate

/**
 * Everything above, in order. The first that fires ends the turn.
 *
 * Disordered eating first: where a message is both that and something else,
 * the kinder and more urgent message is the one to show. Medicines before
 * the record's signals, since "can I stop my thyroid tablet" from someone
 * with a low target is a medicine question. Diagnosis last, being the
 * mildest.
 *
 * R1 is not in here. It runs before this, in the same place it always has,
 * and an emergency is never shown one of these gentler messages instead.
 */
export function gate(input: string, signals: Signals = { calorieTarget: null, weights: [] }, now = Date.now()): Stop | null {
  const t = norm(input);
  if (!t) return null;

  if (EATING.some((p) => p.test(t))) return stop('eating');

  const kcal = dailyCalories(t);
  if (kcal != null && kcal < CALORIE_FLOOR) return stop('low-calories');

  const rate = goalRate(t);
  if (rate && rate.direction === 'lose' && rate.kgPerWeek > MAX_LOSS_KG_PER_WEEK) return stop('fast-goal');
  if (rate && rate.direction === 'gain' && rate.kgPerWeek > MAX_GAIN_KG_PER_WEEK) return stop('fast-goal');
  if (!rate && FAST_WORDS.some((p) => p.test(t))) return stop('fast-goal');

  if (FAST_ALWAYS.some((p) => p.test(t))) return stop('long-fast');
  const hours = fastHours(t);
  if (hours != null && hours > MAX_FAST_HOURS && !OBSERVANCE.test(t)) return stop('long-fast');

  if (MISSED_NOW.test(t)) return stop('medicine-change');
  if (INTENT.test(t) && CHANGE.some((p) => p.test(t))) return stop('medicine-change');
  if (MED_HINGLISH.some((p) => p.test(t))) return stop('medicine-change');

  if (FOOD_OR_WEIGHT.test(t)) {
    if (signals.calorieTarget != null && signals.calorieTarget > 0 && signals.calorieTarget < CALORIE_FLOOR) return stop('low-target');
    const falling = lossRate(signals.weights, now);
    if (falling != null && falling > MAX_LOSS_KG_PER_WEEK) return stop('fast-loss');
  }

  if (DIAGNOSIS.some((p) => p.test(t))) return stop('diagnosis');

  return null;
}

/**
 * With nothing tracked, Ask Mealo has nothing to work from and says so.
 *
 * Kept apart from `gate` because it is about the record and not the words,
 * and because it is checked later: a request for a report, or a stop, should
 * still reach someone on their first day.
 */
export function emptyRecordStop(tracked: boolean): Stop | null {
  return tracked ? null : stop('nothing-tracked');
}
