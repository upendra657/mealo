/**
 * Requirement R1: red-flag triage runs as plain code, before any model call.
 *
 * Moved forward from Phase 4 because it cannot be later than the first screen
 * that accepts a symptom. A model is the wrong thing to put in front of "I have
 * chest pain": it is probabilistic, it can be talked out of its judgement, and
 * measured unsafe-answer rates for consumer chatbots on patient questions run
 * 5–13.5%. A regex cannot be persuaded and cannot hallucinate.
 *
 * Deliberately over-triggers. A false positive costs an unnecessary "go get
 * seen"; a false negative costs something that does not bear thinking about.
 * Tune only in the direction of catching more.
 *
 * This list is not medical advice and is not exhaustive — it is a floor.
 *
 * Note the absence of trailing \b on these patterns. An earlier version had
 * them, and three phrases silently failed: "drooping" does not end where
 * "droop" does, so a word boundary immediately after rejected the match. Under
 * stress people also reorder words — "speech is slurred", not "slurred speech"
 * — so these match a pair of ideas near each other rather than a fixed
 * phrasing.
 */

export type RedFlag = {
  id: string;
  /** Matched against the lowercased message. */
  pattern: RegExp;
  /** What to tell the user. Written to be read while frightened. */
  advice: string;
  severity: 'emergency' | 'urgent';
};

export const RED_FLAGS: RedFlag[] = [
  {
    id: 'chest-pain',
    pattern:
      /(chest (pain|pressure|tight)|pain in (my |the )?chest|crushing chest)/,
    advice:
      'Chest pain needs assessing in person now, not by an app. Call emergency services or get to an emergency department. Do not drive yourself.',
    severity: 'emergency',
  },
  {
    id: 'breathing',
    pattern:
      /(can'?t breathe|cannot breathe|trouble breathing|short(ness)? of breath|struggling to breathe|gasping|breathless)/,
    advice:
      'Difficulty breathing needs emergency care now. Call emergency services.',
    severity: 'emergency',
  },
  {
    id: 'stroke',
    // Word order varies wildly under stress: "face is drooping", "speech is
    // slurred", "my arm went numb". Match the pair, not a phrasing.
    pattern:
      /(face .{0,8}droop|droop.{0,10}face|speech .{0,8}slurr|slurr.{0,10}speech|can'?t speak|sudden (weakness|numbness)|one side.{0,20}(numb|weak)|arm .{0,10}numb)/,
    advice:
      'Sudden weakness, numbness on one side, or slurred speech can mean a stroke, where minutes matter. Call emergency services immediately.',
    severity: 'emergency',
  },
  {
    id: 'worst-headache',
    pattern:
      /(worst headache|thunderclap|sudden(est)? (severe )?headache|headache.{0,15}(worst|ever))/,
    advice:
      'A sudden, severe, worst-ever headache needs emergency assessment now. Call emergency services.',
    severity: 'emergency',
  },
  {
    id: 'anaphylaxis',
    pattern:
      /(throat .{0,8}(clos|swell|tight)|tongue .{0,8}swell|anaphyla|lips .{0,8}swell|hives.{0,20}breath)/,
    advice:
      'Swelling of the throat, tongue or lips can be anaphylaxis. Use an adrenaline auto-injector if you have one and call emergency services now.',
    severity: 'emergency',
  },
  {
    id: 'bleeding',
    pattern:
      /(vomit.{0,10}blood|cough.{0,10}blood|blood in (my |the )?(stool|vomit|urine)|bleeding (heavily|a lot|won'?t stop)|black tarry)/,
    advice:
      'Bleeding like this needs urgent in-person assessment. Go to an emergency department.',
    severity: 'emergency',
  },
  {
    id: 'overdose',
    pattern:
      /(overdose|took too (many|much)|double dose.{0,20}(worried|scared)|poisoned)/,
    advice:
      'If you have taken more than intended, contact emergency services or a poison control centre now. Have the packet with you.',
    severity: 'emergency',
  },
  {
    id: 'self-harm',
    pattern:
      /(kill myself|suicid|end my life|self[- ]harm|hurt myself|don'?t want to (be here|live)|no reason to live|better off without me)/,
    advice:
      "I'm not the right kind of help for this, and I don't want to be the only thing you're talking to about it. Please reach someone now — a crisis line, someone you trust, or emergency services. If you'd like, I can help you find a line where you are.",
    severity: 'emergency',
  },
  {
    id: 'severe-abdominal',
    pattern:
      /(severe (abdominal|stomach|belly) pain|abdomen.{0,15}rigid|can'?t stand up straight.{0,20}pain)/,
    advice:
      'Severe abdominal pain needs assessing in person today. Contact urgent care or an emergency department.',
    severity: 'urgent',
  },
  {
    id: 'high-fever',
    pattern:
      /(fever.{0,12}(10[4-9]|4[1-3](\.\d)?\s*(c|celsius))|temperature.{0,12}(10[4-9]|4[1-3]))/,
    advice:
      'A fever that high needs medical assessment today, particularly with confusion, a stiff neck or a rash.',
    severity: 'urgent',
  },
  {
    id: 'stiff-neck-rash',
    pattern: /(stiff neck.{0,30}(fever|rash)|fever.{0,30}stiff neck|rash.{0,30}(doesn'?t|does not) fade)/,
    advice:
      'A stiff neck with fever, or a rash that does not fade under pressure, can mean meningitis. Seek emergency care now.',
    severity: 'emergency',
  },
  {
    id: 'pregnancy-bleeding',
    pattern: /(pregnan\w*.{0,30}(bleed|cramp|pain)|bleed\w*.{0,20}pregnan)/,
    advice:
      'Bleeding or pain during pregnancy needs assessing today. Contact your maternity unit or emergency services.',
    severity: 'urgent',
  },
];

export type TriageResult = {
  triggered: true;
  flag: RedFlag;
  message: string;
} | {
  triggered: false;
};

/**
 * Runs before any model call. Returns the response to show instead when a flag
 * fires — the model is never consulted on these.
 */
export function triage(input: string): TriageResult {
  const text = input.toLowerCase();
  for (const flag of RED_FLAGS) {
    if (flag.pattern.test(text)) {
      return {
        triggered: true,
        flag,
        message: flag.advice,
      };
    }
  }
  return { triggered: false };
}

/** Phrases that must all trigger. Used by the R1 test. */
export const R1_TEST_PHRASES = [
  'I have chest pain',
  "I can't breathe properly",
  'my face is drooping and my speech is slurred',
  'worst headache of my life',
  'my throat is closing up',
  'I have been vomiting blood',
  'I think I took too many by accident',
  'I want to kill myself',
  'severe abdominal pain since morning',
  'fever 104 and shivering',
  'stiff neck with fever',
  'I am pregnant and bleeding',
];
