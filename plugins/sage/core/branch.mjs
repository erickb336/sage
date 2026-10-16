/**
 * A branch that a task or a writer run may name: letters, digits and . _ / -, as today's branches (sage/t94,
 * tool/t83-agent-state-writes). Not main, master or HEAD in any case (a Mac's file names ignore case), not under refs/,
 * heads/, remotes/ or origin/ (git reads those as other refs), not starting with - or a /, and none of the
 * forms that git refuses or reads otherwise: .., //, /., a final / or ., or .lock. @{, ~, ^, :, spaces and control
 * characters are outside the letters. The one pattern for every branch check in this tool: task set and run add.
 */
export const BRANCH = /^(?![-./])(?!(?:refs|heads|remotes|origin)\/)(?!(?:main|master|HEAD)$)(?!.*(?:\.\.|\/\/|\/\.|\.lock(?:\/|$)|[/.]$))[A-Za-z0-9._/-]+$/i;
