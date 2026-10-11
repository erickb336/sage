import { BOARD_PHRASES } from "./board-intent.mjs";

// The owner's phrases (owner decision 2026-10-11, T240). A message switches a mode only when it is exactly one phrase:
// the whole message, after trimming the spaces at its ends, in any letter case, with at most one full stop at the end.
// Nothing else switches: no more words, no look-alike letter, no hidden character, no other punctuation. So the rule
// never guesses from free text. Each value is what the phrase does; the help phrase switches nothing.
export const PHRASES = {
  "sage mode": { sage: true, what: "turns sage mode on" },
  "sage mode on": { sage: true, what: "turns sage mode on" },
  "sage mode off": { sage: false, autopilot: false, what: "turns sage mode off, and autopilot with it" },
  "autopilot on": { autopilot: true, what: "turns autopilot on, while sage mode is on" },
  "autopilot off": { autopilot: false, what: "turns autopilot off" },
  "sage help": { help: true, what: "shows this list" },
};
const SWITCHES = Object.keys(PHRASES).filter((phrase) => !PHRASES[phrase].help);

/** The phrase that the message is exactly, or null. The i flag without u folds only ASCII letters. */
export function exactPhrase(message) {
  const text = message.trim().replace(/\.$/, "");
  return Object.keys(PHRASES).find((phrase) => new RegExp(`^${phrase}$`, "i").test(text)) ?? null;
}

/** Whether a text has a switch phrase anywhere: for a prompt whose frames the hook cannot read. */
export const hasPhrase = (text) => new RegExp(`\\b(?:${SWITCHES.join("|")})\\b`, "i").test(text);

/**
 * A near miss: a message that is no phrase, but names sage mode or autopilot with an on or off word, or starts with
 * one of them. Returns the phrases to ask the owner for, and strong when the message starts like a phrase (a mention
 * in a sentence is weak), or null for no near miss. The plain form (compatibility letters, no marks, no hidden
 * characters, "_" and "-" as spaces, and joined words split: "autopilotoff") only finds a near miss; it never switches.
 */
export function phrasesNear(message) {
  if (exactPhrase(message)) return null;
  const plain = message.normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, "").toLowerCase().replace(/[_-]/g, " ").replace(/(sage|mode|autopilot)(?=[a-z])/g, "$1 ");
  const sage = /\bsage\s+mode\b/.test(plain);
  const autopilot = /\bauto\s?pilot\b/.test(plain);
  const on = /\b(?:on|start|enable|resume)\b/.test(plain);
  const off = /\b(?:off|stop|pause|disable|end|exit|quit)\b/.test(plain);
  const strong = /^\s*(?:sage\s+mode|auto\s?pilot)\b/.test(plain);
  if (!(sage || autopilot) || !(on || off || strong)) return null;
  const pick = (onPhrase, offPhrase) => (on === off ? [onPhrase, offPhrase] : [on ? onPhrase : offPhrase]);
  return { phrases: [...(sage ? pick("sage mode", "sage mode off") : []), ...(autopilot ? pick("autopilot on", "autopilot off") : [])], strong };
}

/** The answer to the help phrase: every phrase the owner can send, from the same lists that the hook matches. */
export function phraseHelp({ sage, autopilot }) {
  const line = (phrases, what) => `- ${phrases.map((p) => `"${p}"`).join(" or ")}: ${what}.`;
  const lines = (help) => Object.entries(PHRASES).filter(([, p]) => Boolean(p.help) === help).map(([p, { what }]) => line([p], what));
  return [
    "sage: the user asked for help. Show the user this list as it is.",
    `Now: sage mode is ${sage ? "on" : "off"}, and autopilot is ${autopilot ? "on" : "off"}.`,
    "Switches: send the phrase alone, as the whole message, in any letter case. Spaces at the ends and one full stop are fine. Any other message switches nothing.",
    "An on phrase works only as a message alone while Claude is idle. An off phrase also works in a message sent while Claude works, but there it turns only autopilot off.",
    ...lines(false),
    "Board: at the start of a message.",
    ...BOARD_PHRASES.map(([a, b, what]) => line([a, b], what)),
    "Maintenance: in a terminal, not in the chat.",
    line(["claude plugin update sage@sage"], "updates sage; each session uses the new version at its next event"),
    "Help:",
    ...lines(true),
  ].join("\n");
}
