/** Literal Start-Process parameters. ArgumentList elements join with spaces before native argv parsing.
 * https://learn.microsoft.com/powershell/module/microsoft.powershell.management/start-process
 * Unknown parameters, expansions and ambiguous native quoting refuse instead of inventing a child command.
 */
const refuse = () => { throw Object.assign(new Error("The hook cannot read this PowerShell launch. Use a literal FilePath and ArgumentList, with optional Wait, PassThru, NoNewWindow or WorkingDirectory."), { code: "SAGE_POWERSHELL_LAUNCH" }); };

function literals(source) {
  const tokens = [];
  let value, quote, quoted = false;
  const end = () => { if (value !== undefined) tokens.push({ value, quoted }); value = undefined; quoted = false; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && source[i + 1] === "'") { value += "'"; i++; }
        else quote = undefined;
      } else {
        if (quote === '"' && /[$`]/.test(c)) refuse();
        value += c;
      }
    } else if (c === "'" || c === '"') { quote = c; quoted = true; value ??= ""; }
    else if (/\s/.test(c)) end();
    else if (c === ",") { end(); tokens.push({ comma: true }); }
    else {
      if (/[$`{}()@]/.test(c)) refuse();
      value = (value ?? "") + c;
    }
  }
  if (quote) refuse();
  end();
  return tokens;
}

function nativeArguments(text) {
  const args = [];
  let value, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && text[i + 1] === '"') refuse();
    if (c === '"') { quoted = !quoted; value ??= ""; }
    else if (/\s/.test(c) && !quoted) { if (value !== undefined) args.push(value); value = undefined; }
    else value = (value ?? "") + c;
  }
  if (quoted) refuse();
  if (value !== undefined) args.push(value);
  return args;
}

export function powerShellLaunch(rawWords) {
  if (!rawWords) refuse();
  const tokens = literals(rawWords.join(" "));
  let program, argumentList, directory;
  const seen = new Set();
  const names = ["filepath", "argumentlist", "workingdirectory", "wait", "passthru", "nonewwindow"];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.comma) refuse();
    let name;
    if (!token.quoted && token.value.startsWith("-")) {
      const prefix = token.value.slice(1).toLowerCase();
      const matches = names.filter(name => name.startsWith(prefix));
      if (!prefix || matches.length !== 1) refuse();
      name = matches[0];
      if (seen.has(name)) refuse();
      seen.add(name);
      if (["wait", "passthru", "nonewwindow"].includes(name)) continue;
      i++;
    } else name = program === undefined ? "filepath" : "argumentlist";
    const value = tokens[i];
    if (!value || value.comma || (!value.quoted && value.value.startsWith("-"))) refuse();
    if (name === "argumentlist") {
      if (argumentList !== undefined) refuse();
      argumentList = [value.value];
      while (tokens[i + 1]?.comma) {
        i += 2;
        const next = tokens[i];
        if (!next || next.comma) refuse();
        argumentList.push(next.value);
      }
    } else if (name === "filepath") {
      if (program !== undefined || !value.value) refuse();
      program = value.value;
    } else {
      if (directory !== undefined || !value.value) refuse();
      directory = value.value;
    }
  }
  if (!program) refuse();
  return { program, args: nativeArguments((argumentList ?? []).join(" ")), directory };
}
