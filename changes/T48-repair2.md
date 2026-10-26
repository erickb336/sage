---
date: 2026-10-26
---
- Historical native updates retain the transition rules of their saved schema.

The failed premise was that the current planner can validate every historical operation.
The first implementation added columns before hashing, which changed saved versions.
The first repair kept columns but applied new approval rules to old round resumes.
Both failures treated historical data as a current request. Recovery must validate
the saved writer's schema and rules; new requests must use the current rules.
