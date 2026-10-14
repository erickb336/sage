# Literal PowerShell launches

The command reader exposes the child of `Start-Process` and its `start` alias as ordinary program evidence. It never runs the command.

Direct callers opt into PowerShell with `programsRun`'s `powerShell: true` option. The reader also selects PowerShell inside `powershell` or `pwsh` command text. A Bash executable named `start` stays an ordinary executable.

Supported forms use literal `FilePath` and `ArgumentList` values, as named parameters in either order or as positional values. Parameter names ignore case and accept unambiguous abbreviations. Argument lists accept one string or comma-separated literal strings. The reader joins these strings with spaces, then reads native argument boundaries. Quoted commas remain data. Optional `Wait`, `PassThru`, `NoNewWindow` and literal `WorkingDirectory` parameters are supported.

Unresolved variables, expressions, unknown or repeated parameters, and ambiguous native quoting refuse. This includes array expressions with parentheses; use a literal comma-separated list. The reader does not claim full PowerShell grammar support. For protected git or gh text, a backslash before a double quote also refuses because the shell reader gives that spelling a different meaning.

These checks classify commands. They neither enable an installed policy nor prove sandbox enforcement.

The argument joining rule follows [Microsoft's Start-Process documentation](https://learn.microsoft.com/powershell/module/microsoft.powershell.management/start-process).
