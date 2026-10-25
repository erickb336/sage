// The mode phrase cases of the Claude hook (T240), shared with the Codex hook test (T453): one table for both hosts.

// A switch needs the exact phrase as the whole message (T240): trimmed, in any letter case, with at most one full stop.
// The near-miss note, strong (the message starts like a phrase) or soft (a mention in a sentence) (F-T240-7).
export const NEAR_NOTE = /^sage: the user's message (?:did not switch, because a switch needs the exact phrase as the whole message\. Ask|names sage mode or autopilot with an on or off word, and did not switch\. Only if the user meant a switch, ask) the user to send (.+) alone, as a message of its own\. Tell the user only if the message was not a question\.$/m;
export const S = ["sage mode"];
export const S_ON = ["sage mode", "autopilot on"];
export const PHRASE_CASES = [
  // [why, the modes before, the owner's message, the modes after, the phrases that the near-miss note names, or null]
  ["the on phrase", [], "sage mode", "sage mode on, autopilot off", null],
  ["the on phrase with on", [], "sage mode on", "sage mode on, autopilot off", null],
  ["the on phrase in capitals", [], "SAGE MODE", "sage mode on, autopilot off", null],
  ["the on phrase in mixed case, with a full stop", [], "Sage Mode On.", "sage mode on, autopilot off", null],
  ["the on phrase with spaces and line breaks around it", [], "  \n sage mode \n", "sage mode on, autopilot off", null],
  ["the off phrase", S_ON, "sage mode off", "sage mode off, autopilot off", null],
  ["the off phrase in capitals, with a full stop", S_ON, " SAGE MODE OFF. ", "sage mode off, autopilot off", null],
  ["the autopilot on phrase", S, "autopilot on", "sage mode on, autopilot on", null],
  ["the autopilot on phrase in capitals, with a full stop", S, "  AUTOPILOT ON.", "sage mode on, autopilot on", null],
  ["the autopilot off phrase", S_ON, "autopilot off", "sage mode on, autopilot off", null],
  ["the autopilot off phrase in mixed case", S_ON, "Autopilot Off.\n", "sage mode on, autopilot off", null],
  // Near misses: nothing switches, and the note names the exact phrase.
  ["the on phrase, then a request", [], "sage mode. Ramen Finder: fix the crash", "sage mode off, autopilot off", '"sage mode" or "sage mode off"'],
  ["the owner's first message of T194", [], "sage mode continue on sage project with remote control on", "sage mode off, autopilot off", '"sage mode"'],
  ["the on phrase and a comma", [], "sage mode, please", "sage mode off, autopilot off", '"sage mode" or "sage mode off"'],
  ["the on phrase as a question", [], "sage mode?", "sage mode off, autopilot off", '"sage mode" or "sage mode off"'],
  ["the on phrase with two full stops", [], "sage mode..", "sage mode off, autopilot off", '"sage mode" or "sage mode off"'],
  ["the on phrase with a full-width mark", [], "sage mode！", "sage mode off, autopilot off", '"sage mode" or "sage mode off"'],
  ["the on phrase with two spaces inside", [], "sage  mode", "sage mode off, autopilot off", '"sage mode" or "sage mode off"'],
  ["the on phrase with a hidden character", [], "sage mode​", "sage mode off, autopilot off", '"sage mode" or "sage mode off"'],
  ["the off phrase, then a request", S_ON, "sage mode off, thanks", "sage mode on, autopilot on", '"sage mode off"'],
  ["the off phrase after a quote mark", S_ON, "> sage mode off", "sage mode on, autopilot on", '"sage mode off"'],
  ["the off phrase with a look-alike letter in the off word", S_ON, "sage mode оff", "sage mode on, autopilot on", '"sage mode" or "sage mode off"'],
  ["the autopilot on phrase, then more words", S, "autopilot on main", "sage mode on, autopilot off", '"autopilot on"'],
  ["the autopilot on phrase as a question", S, "autopilot on?", "sage mode on, autopilot off", '"autopilot on"'],
  ["an on request for autopilot", S, "turn on autopilot", "sage mode on, autopilot off", '"autopilot on"'],
  ["an off request for autopilot", S_ON, "please stop autopilot", "sage mode on, autopilot on", '"autopilot off"'],
  ["the autopilot off phrase with a hidden character", S_ON, "autopilot​ off", "sage mode on, autopilot on", '"autopilot off"'],
  ["the autopilot off phrase with a look-alike letter", S_ON, "autopilot оff", "sage mode on, autopilot on", '"autopilot on" or "autopilot off"'],
  ["the autopilot off phrase in full-width letters", S_ON, "ａｕｔｏｐｉｌｏｔ ｏｆｆ", "sage mode on, autopilot on", '"autopilot off"'],
  ["the old combined phrase", [], "sage mode autopilot", "sage mode off, autopilot off", '"sage mode" or "sage mode off" or "autopilot on" or "autopilot off"'],
  ["an on and an off in one message", S_ON, "autopilot on, don't stop until done", "sage mode on, autopilot on", '"autopilot on" or "autopilot off"'],
  // A look-alike letter inside "sage mode" itself hides the mode words too: no switch, and no note.
  ["a look-alike letter inside the phrase", [], "sage mоde", "sage mode off, autopilot off", null],
  // Ordinary requests: nothing switches, and no note.
  ["a request that mentions autopilot", S_ON, "fix the autopilot tests", "sage mode on, autopilot on", null],
  ["a request that says stop", S_ON, "stop the build and run it again", "sage mode on, autopilot on", null],
  ["a request that mentions sage mode in a sentence", [], "what does sage mode do", "sage mode off, autopilot off", null],
  // Joined forms, "_", "-" and hidden characters between the words still get the note, and never switch (F-T240-4).
  ["the autopilot word joined to the off word", S_ON, "autopilotoff", "sage mode on, autopilot on", '"autopilot off"'],
  ["the autopilot word and the off word with an underscore", S_ON, "autopilot_off", "sage mode on, autopilot on", '"autopilot off"'],
  ["the autopilot word and the off word with a hyphen", S_ON, "Autopilot-Off", "sage mode on, autopilot on", '"autopilot off"'],
  ["the mode words joined", S_ON, "sagemode off", "sage mode on, autopilot on", '"sage mode off"'],
  ["the mode words with a word joiner between them", S_ON, "sage\u2060mode off", "sage mode on, autopilot on", '"sage mode off"'],
  ["the mode words with an underscore", [], "sage_mode", "sage mode off, autopilot off", '"sage mode" or "sage mode off"'],
  // The rules that stay: autopilot turns on only in sage mode, and a repeated phrase is no near miss.
  ["the autopilot on phrase outside sage mode", [], "autopilot on", "sage mode off, autopilot off", null],
  ["the on phrase while sage mode is on", S, "sage mode", "sage mode on, autopilot off", null],
];

// Codex only (R1652-1): a review or guardian subsession sends UserPromptSubmit with the root session's id and no
// agent_id, so the hook reads its prompt as the owner's. These prompts have the shape of Codex 0.160.0's own prompts
// (sample text, not copied): they hold the phrases inside more text, so they switch nothing.
export const SUBSESSION_PROMPTS = [
  ["a review subsession", "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.\n\nThe user asked: sage mode off"],
  ["a guardian subsession", ">>> TRANSCRIPT START\n[1] user: sage mode off\n[2] user: autopilot off\n>>> TRANSCRIPT END\n\nThe agent asks to run: gh pr merge 12 --squash"],
];
