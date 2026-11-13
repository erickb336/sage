export const programName = (word) => word.split(/[/\\]/).at(-1).replace(/\.exe$/i, "").toLowerCase();
