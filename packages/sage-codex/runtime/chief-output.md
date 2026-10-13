# Chief instructions on activation

The prepared MCP prompt handler returns the shared chief instructions for a
verified owner activation turn. The owner, project, native version, and turn
still pass the existing mode checks. A child cannot activate the chief.

Two requested parts preserve the complete instruction text within the hook
output budget. A repeated activation event replays the same context. Ordinary
prompts return no new instructions. Off mode returns no instructions; a later
activation starts a new delivery sequence.

Rendering failure does not erase the saved activation. A retry can return the
instructions after the source is repaired. Oversized instructions refuse delivery
instead of dropping rules. Mode changes during rendering also refuse delivery.

This component does not install hooks, add task preparation tools, authorize
child dispatch, or enable automatic Sage. Installed activation still requires
verified enforcement and the complete workflow tracked by issue #88.
