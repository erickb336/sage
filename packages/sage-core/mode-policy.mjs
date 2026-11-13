import { BOARD_PHRASES } from "./board-intent.mjs";

export const PHRASES = {
  "sage mode": { sage: true, what: "turns sage mode on" },
  "sage mode on": { sage: true, what: "turns sage mode on" },
  "sage mode off": { sage: false, autopilot: false, what: "turns sage mode off, and autopilot with it" },
  "autopilot on": { autopilot: true, what: "turns autopilot on, while sage mode is on" },
  "autopilot off": { autopilot: false, what: "turns autopilot off" },
  "sage help": { help: true, what: "shows this list" },
};
const SWITCHES = Object.keys(PHRASES).filter((phrase) => !PHRASES[phrase].help);

export function exactPhrase(message) {
  const text = message.trim().replace(/\.$/, "");
  return Object.keys(PHRASES).find((phrase) => new RegExp(`^${phrase}$`, "i").test(text)) ?? null;
}

export const hasPhrase = (text) => new RegExp(`\\b(?:${SWITCHES.join("|")})\\b`, "i").test(text);

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

const claudeHost = {
  name: "Claude",
  timing: "An on phrase works only as a message alone while Claude is idle. An off phrase also works in a message sent while Claude works, but there it turns only autopilot off.",
  update: "claude plugin update sage@sage",
};

export function phraseHelp({ sage, autopilot }, host = claudeHost) {
  const line = (phrases, what) => `- ${phrases.map((p) => `"${p}"`).join(" or ")}: ${what}.`;
  const lines = (help) => Object.entries(PHRASES).filter(([, p]) => Boolean(p.help) === help).map(([p, { what }]) => line([p], what));
  return [
    "sage: the user asked for help. Show the user this list as it is.",
    `Now: sage mode is ${sage ? "on" : "off"}, and autopilot is ${autopilot ? "on" : "off"}.`,
    "Switches: send the phrase alone, as the whole message, in any letter case. Spaces at the ends and one full stop are fine. Any other message switches nothing.",
    host.timing,
    ...lines(false),
    "Board: at the start of a message.",
    ...BOARD_PHRASES.map(([a, b, what]) => line([a, b], what)),
    ...(host.update ? ["Maintenance: in a terminal, not in the chat.", line([host.update], "updates sage; each session uses the new version at its next event")] : []),
    "Help:",
    ...lines(true),
  ].join("\n");
}

export function switchModes({ owner, text, queued = [], all, stray = "" }, state, { autopilotOn, host = claudeHost }) {
  const notes = (!owner && hasPhrase(all)) || hasPhrase(stray) ? ["sage: the hook could not read the frames of this prompt, so it switched no mode. A switch phrase in this prompt was not applied: if the user sent one, ask the user to send it again as a message alone."] : [];
  const near = new Set();
  let strong = false;
  const queuedOff = new Set();
  let queuedMiss = false;
  let help = false;
  const quote = (phrases) => [...phrases].map((p) => `"${p}"`).join(" or ");
  for (const [i, message] of (owner ? [text, ...queued] : []).entries()) {
    const phrase = exactPhrase(message);
    let change = PHRASES[phrase] ?? {};
    const miss = phrasesNear(message);
    if (i > 0) {
      const off = (p) => PHRASES[p].sage !== true && PHRASES[p].autopilot !== true && !PHRASES[p].help;
      if (change.sage === false && state.sage) queuedOff.add(phrase);
      queuedMiss ||= Boolean(miss) || change.sage === true || change.autopilot === true || (change.sage === false && state.sage);
      for (const p of miss?.phrases ?? []) if (off(p)) queuedOff.add(p);
      change = { autopilot: change.autopilot === false ? false : undefined, help: change.help };
    } else if (miss) {
      for (const p of miss.phrases) near.add(p);
      strong ||= miss.strong;
    }
    help ||= Boolean(change.help);
    if (change.sage === false) {
      if (state.sage) notes.push("sage: sage mode is off. This is a normal session for the rest of it, also when it started as the chief: you may change files yourself again.");
      Object.assign(state, { sage: false, off: "owner", given: false, autopilot: false });
    } else if (change.sage) {
      state.sage = true;
      delete state.off;
    }
    if (change.autopilot === false) {
      if (state.autopilot) notes.push("sage: autopilot is off. Work stops at verified, and the user merges.");
      state.autopilot = false;
    } else if (change.autopilot && !state.sage) {
      notes.push('sage: autopilot did not switch on, because it turns on only while sage mode is on. Ask the user to send "sage mode" first, then "autopilot on", each as a message alone.');
    } else if (change.autopilot && !state.autopilot) {
      state.autopilot = true;
      notes.push(autopilotOn());
    }
  }
  const ask = "Tell the user only if the message was not a question.";
  if (near.size && strong) notes.push(`sage: the user's message did not switch, because a switch needs the exact phrase as the whole message. Ask the user to send ${quote(near)} alone, as a message of its own. ${ask}`);
  else if (near.size) notes.push(`sage: the user's message names sage mode or autopilot with an on or off word, and did not switch. Only if the user meant a switch, ask the user to send ${quote(near)} alone, as a message of its own. ${ask}`);
  if (queuedMiss || queuedOff.size) notes.push(`sage: a message sent while ${host.name} works did not switch a mode. The hook cannot tell such a message from an agent's text, so it lets it switch autopilot off only.${queuedOff.size ? ` If the user sent it, ask the user to send ${quote(queuedOff)} alone when ${host.name} is idle.` : ""} Tell the user only if the user sent it.`);
  if (help) notes.push(phraseHelp(state, host));
  return notes;
}

const OFF = { sage: false, autopilot: false };
export const MODE_DAMAGED = 'sage: the sage mode file of this session was damaged, so sage mode and autopilot are now off. Send "sage mode" alone to turn sage mode on again.';

export function readModeFile(read, file) {
  let state;
  try {
    state = read(file);
  } catch (error) {
    return error?.code === "ENOENT" ? { state: {}, damaged: false } : { state: { ...OFF }, damaged: true };
  }
  const valid = state !== null && typeof state === "object" && !Array.isArray(state) && ["sage", "autopilot", "given"].every((k) => state[k] === undefined || typeof state[k] === "boolean");
  return valid ? { state, damaged: false } : { state: { ...OFF }, damaged: true };
}
