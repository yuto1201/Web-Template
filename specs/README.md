# Specifications

`specs/` is the product and architecture source of truth. Update it before implementation when a change alters behavior, trust boundaries, deployment topology, or acceptance criteria.

| File | Purpose |
| --- | --- |
| `product.md` | Template goals, users, and non-goals |
| `architecture.md` | Runtime components and trust boundaries |
| `acceptance.md` | Template-level completion criteria |
| `decisions.md` | Accepted decisions and supersession history |

Feature-specific detail belongs in the active GitHub Issue. If it will remain true after that Issue closes, promote it into this directory in the same pull request.
