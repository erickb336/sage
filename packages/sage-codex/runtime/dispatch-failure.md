# Recover a rejected initial spawn

An initial spawn reserves capacity before Codex tries to create the child. The runtime releases that slot only when the protected sender transcript proves the captured Codex 0.160.0 unknown-model rejection.

The adapter checks the current actor, owner epoch, original request, call, turn, and argument hash. Native metadata must mark both records as server-authored. The error must name the dispatched model. Other errors retain capacity. A successful dispatch result, child-start record, or saved binding also retains capacity on this path.

Reconciliation runs before a new admitted spawn and after native list or wait callbacks. It can recover preserved work after Sage turns off. An initial lead can reconcile its own rejected child; another actor cannot release that reservation.

Core saves an immutable failure receipt, separately from child completion. Repeating the same receipt changes nothing. Changed identity or evidence, a bound assignment, and a late binding refuse. A failed call never grants another dispatch permission; a retry needs a new preparation and call.

This extraction covers initial spawns. Later assignments, other failure kinds, cross-session recovery, and installed activation remain separate work. Packaged tests cover the accounting and evidence checks. The isolated native retry probe still needs extraction and verification for this component.
