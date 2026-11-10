---
id: type-system-discipline
name: Type system discipline
applyWhen: you design types, review a function signature or write code in a statically typed language.
source: pstack principle-type-system-discipline, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins, adapted; checked against pstack 0.15.36 at commit 0bb6f37
---

Make the compiler reject impossible states, mixed-up primitives and unhandled variants. Define errors and special cases out of existence instead of adding more handlers.

- **Make illegal states unrepresentable.** Model variants as a tagged union, not as optional fields whose contradictory combinations compile.
- **Build shapes that cannot hold the illegal value:** a non-empty list is a head plus a rest.
- **Strengthen a type only where partiality appears:** where the loose type forces a cast, a null check or a "should never happen" throw.
- **Brand semantic primitives** that share a type but mean different things, such as a `UserId` and an `OrderId` string. Give each its own type (a brand or a newtype), validate it once at creation, and trust it downstream.
- **Parse external data at each boundary** into the typed model: JSON, messages, arguments, configuration, environment variables, database rows (see "boundary discipline").
- **Do not lie to the compiler.** A cast is a latent crash: cast only after validation.
- **Make every match exhaustive:** a new variant without a case must fail to compile.
- **Derive types from the schema that owns the shape,** such as an OpenAPI spec, not a parallel type by hand.
