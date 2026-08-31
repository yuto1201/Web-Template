# Site-wide theme

This is the source of truth for the generated application's visual direction. Complete it after the target users and MVP are known, before implementing individual product pages. Keep it short: one direction, shared tokens/components, and one representative desktop/mobile confirmation.

The template's existing CSS and fonts are an **unapproved baseline**, not an application theme decision. Shipping this document, initializing the repository, or passing checks does not confirm a theme. This template intentionally leaves the application choices below unconfirmed.

## Timing and readiness

| Stage | Required outcome | What may proceed |
| --- | --- | --- |
| Product discovery | Target users/MVP and a draft visual direction | Repository planning; no implied creation or implementation authority |
| Bootstrap / app specification | Record the draft, open choices and representative preview plan here | Identity/specification work may finish with theme pending; no feature or preview implementation inside bootstrap |
| Next authorized UI Issue | Build only a bounded, nonfunctional representative preview; show desktop/mobile; obtain and record user confirmation | After confirmation, implement the remaining product UI using the accepted theme |
| Later UI work | Reuse the accepted direction and shared primitives | Minor adjustments without per-page approval; reconfirm material direction changes |

The representative preview is the explicit exception to the pre-UI confirmation rule, so confirmation never depends on already having implemented the whole site. Use local dummy content and existing local tooling; no live provider activation, production data, new integration or deployment is implied. Choose one screen or small flow that exposes the typography, palette, layout, actions and shared navigation/footer; include login/form treatment if relevant. A separate theme Issue, design platform, component catalog or new CI gate is not mandatory.

Theme-independent setup/backend work may continue within its authorized Issue while visual choices are pending. Report bootstrap completion, local readiness, theme confirmation/UI-ready and public-release readiness separately. `npm run readiness` checks local identity/configuration, not visual decisions. Unrelated product, privacy, security or account blockers are not waived.

## Application theme record

- Status: **unconfirmed** (use `draft` while exploring and `confirmed` only with the evidence below).
- Audience / MVP reference: not yet recorded.
- Direction in one sentence and qualities to avoid: not yet selected.

| Decision | Record for this application |
| --- | --- |
| Mood and tone | Intended impression and content tone; not yet selected |
| Palette | Background/surface/text/action/feedback roles and light/dark policy; not yet selected |
| Typography | Display/body/utility fonts, hierarchy, fallback and local/remote delivery; not yet selected |
| Layout and spacing | Content widths, spacing scale, density and desktop/mobile behavior; not yet selected |
| Shape and depth | Radii, borders and shadows; not yet selected |
| Images and icons | Style, source/usage constraints and alternatives when absent; not yet selected |
| Interaction and access | Focus, readable contrast, non-color cues, reduced motion and disabled/error states; not yet selected |
| Shared implementation | Semantic token names and shared component/source locations; not yet mapped |

Explicitly record omissions such as no dark mode or no photography rather than introducing a second theme by accident. Resolve choices that affect the representative direction before confirmation; do not invent user preferences. Remote fonts/assets or other external services still follow the existing privacy and account-bound authority rules.

### Confirmation evidence

Complete these fields from an actual user confirmation, not from an AI's verdict:

- Specification revision / relevant commit: not yet recorded.
- Representative screen or flow and desktop/mobile artifact references: not yet recorded.
- Confirmed by / date / conversation or Issue reference identifying the actual approval: not yet recorded.
- Accepted scope, remaining nonblocking details and next UI Issue: not yet recorded.

Use retained, redacted screenshots or a reproducible preview reference tied to the reviewed revision. Never include credentials or personal data. A `confirmed` label alone is not evidence. If confirmation is unavailable, keep the theme pending and continue only independent authorized work. Prior genuine confirmation may be reused when its artifacts and direction still match; do not ask again just because a session restarted.

## Applying the theme everywhere

- Express reusable decisions through shared semantic CSS variables and components, initially in [global styles](../src/app/globals.css), [root layout](../src/app/layout.tsx) and [shared components](../src/components). Record the actual locations above if an app changes this structure.
- Apply the same direction to home, feature pages, login, `/terms`, `/privacy`, navigation/footer and loading/empty/error states. Public legal pages keep their anonymous access and readability; visual styling does not change their content-review requirement.
- Reuse tokens and component variants rather than duplicating per-page palettes/fonts or introducing a competing theme. Intentional exceptions need a concrete reason in this specification or the Issue.
- Keep specification and shared implementation aligned in the same change. Review the affected surfaces at desktop/mobile sizes, including keyboard/focus and readable legal/body text. Use existing focused tests and the repository's risk-derived checks; do not add a separate approval round for every page.

## Changes after confirmation

Reconfirm a change that materially alters the accepted mood, palette, typography, layout density or image direction across the site. Present the affected representative view(s) together, retain the earlier approval, and append the replacement decision to [decisions.md](decisions.md).

Minor spacing/radius adjustments, a consistent component variant, token reuse or a token addition/rename that preserves the accepted direction do not need renewed user approval. Record the rationale and affected surfaces in the Issue/PR and run the relevant checks. Judge visual impact, not simply whether `:root` was edited. Fixes must not weaken accessibility, authentication, privacy or external-operation controls.

## Verification boundary

The acceptance trace, link checks and clean-room checks preserve this workflow's files and inheritance. They do **not** judge aesthetics, authenticate user approval or prove legal/public-release readiness. Independent model review can identify missing decisions and inconsistencies, but cannot replace the user's initial theme confirmation. The normal Issue/review/CI rules remain unchanged.
