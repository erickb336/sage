# Hidden characters

The tool keeps no hidden character in a cell, and removes them from the standing orders. Hidden characters are those that a person does not see but a terminal or an agent acts on:

- the control characters (C0, DEL and C1), except a tab and a line end in the standing orders;
- the bidi embeddings, overrides, isolates and marks (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F, U+061C);
- the zero-width characters (U+200B to U+200D, U+2060, U+FEFF);
- the variation selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF);
- the tag characters (U+E0000 to U+E007F), text that only an agent reads.

Other text stays: each script, and emoji. A zero-width joiner or non-joiner between two letters stays: Persian and Indic text needs it. A zero-width joiner between two emoji stays, so a joined emoji stays whole, and the emoji selector (U+FE0F) stays after an emoji or a keycap base (`1️⃣`). A subdivision flag (England, Scotland, Wales) shows as a black flag.

The tool prints each hidden character in an id, a column or a path as `\xNN` or `\u{N}`. For a project path with a control character, it prints no command to paste.
