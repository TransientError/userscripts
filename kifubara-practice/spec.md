# Kifubara Practice Userscript

**Status:** Proposed

## Goal

Add a spoiler-free Practice mode to Kifubara game reviews. At each selected
position, the user guesses the recorded next move before seeing the answer or AI
suggestions. Matching guesses advance immediately. Different guesses reveal a
comparison on the original position.

This userscript adapts the interaction from KaTrain Review Practice while
respecting the smaller public interface available from Kifubara.

## Core Loop

1. The user navigates to any review position and enables **Practice**.
2. The script hides the recorded next move, AI candidates, result, player
   identities, comments, and other answer-bearing UI.
3. A legal board click or Pass submits one guess.
4. If the guess matches the selected recorded continuation, Kifubara advances
   immediately and the next position remains hidden.
5. If the guess differs, Kifubara plays it as a temporary variation and performs
   its normal analysis.
6. When sufficient analysis arrives, the script returns to the pre-move
   position and reveals:
   - **You:** the guessed coordinate;
   - **Game:** the recorded next move;
   - **AI:** the best available candidate;
   - available same-position evaluations and a You-versus-Game verdict.
7. Normal forward navigation, or selecting the Game marker, follows the recorded
   continuation and returns to the hidden state.

Practice starts at the current position. It does not require a range, score,
streak, retry, or whole-game session.

## Analysis Strategy

The existing Kifubara userscript bridge exposes enough state for the navigation
and reveal loop:

- `kifubara:reviewping` / `kifubara:reviewstate`
- `kifubara:movechange`
- `kifubara:variation`
- `kifubara:gotoMove`
- `kifubara:playCoord`
- `window.__KIFU_ANALYSIS`

Kifubara analyzes a move played through its normal review UI. Practice can use
that native behavior to evaluate guesses outside the existing candidate list:

1. Snapshot the pre-move node, recorded continuation, and existing analysis.
2. Play the guessed coordinate through `kifubara:playCoord`.
3. Treat the resulting child as a transient Practice variation.
4. Wait for node-matched full analysis of that child.
5. Capture the resulting evaluation as the guessed move's value.
6. Navigate back to the snapshotted pre-move node.
7. Show the comparison without resubmitting or analyzing the guess again.

If analysis is pending, show an explicit analyzing state and keep navigation
available. If analysis fails or times out, return to the pre-move node and show
the guess as **Analysis unavailable**. Never substitute zero or infer a worst
grade.

The guessed child evaluates the position after the move. Its score or win-rate
must be normalized to the original mover's perspective before comparison with
the recorded move. Only compatible metrics may be compared.

## User Interface

### Toggle

- Add a **Practice** toggle near Kifubara's AI/review controls.
- Active state must be visible and accessible through `aria-pressed`.
- Persist the user's enabled preference for the current tab only; loading a
  different game always starts with Practice off.
- Keyboard and gamepad bindings may be added after the pointer workflow works.

### Hidden State

While awaiting a guess:

- Hide native AI candidate markers, variation ghosts, result text, and any
  visible next-move indication.
- Hide or mask player names and ranks because they may identify the game.
- Disable candidate hover previews.
- Do not change Kifubara's saved AI-display preference; visibility overrides are
  temporary.
- Keep stones, coordinates, move navigation, and the game tree usable.

The userscript must fail closed. If it cannot identify or suppress a known
spoiler surface, it must show **Practice unavailable on this page version**
instead of enabling a partially hidden mode.

### Reveal State

After a different guess:

- Keep the viewer on the exact pre-move node.
- Draw distinct markers for You, Game, and AI. Coincident identities share one
  intersection with combined labeling.
- Show coordinates, available evaluation values, and whether the guess is
  better, equivalent at displayed precision, worse, or not evaluable relative
  to the game move.
- Label candidate-derived comparisons **Approximate**.
- Do not treat a coordinate mismatch as an incorrect move.
- Block additional board guesses until reveal is cleared.

The comparison should reuse Kifubara's existing panel where practical. A compact
userscript-owned panel is acceptable when native content cannot be replaced
without fragile framework manipulation.

## State Model

Practice has three states:

- `off`
- `awaiting`
- `analyzing`
- `revealing`

An attempt records:

- viewer element;
- page path;
- current node ID and move number;
- side to move;
- recorded continuation coordinate and node ID;
- guessed coordinate;
- transient guessed-child node ID;
- analysis request generation and timeout;
- candidate snapshot used for comparison.

Every asynchronous callback must verify the attempt identity before changing the
UI.

### Transitions

- `off -> awaiting`: user enables Practice on a supported review position.
- `awaiting -> awaiting`: exact match advances to the recorded child.
- `awaiting -> analyzing`: different legal guess creates a transient child.
- `analyzing -> revealing`: full node-matched analysis arrives and the script
  returns to the pre-move node.
- `analyzing -> revealing`: analysis fails or times out; reveal reports the
  unavailable value.
- `revealing -> awaiting`: forward navigation follows the recorded child.
- `awaiting|analyzing|revealing -> off`: toggle off, game change, editor mode,
  unsupported state, or bridge failure.
- Navigation to another position clears the current attempt. If Practice remains
  enabled, the new position enters `awaiting`.

## Recorded Continuation

- Use the next move from the currently selected recorded continuation, including
  an existing variation.
- Snapshot the answer before accepting the guess.
- Never allow the transient guessed child to replace the snapshotted recorded
  continuation.
- A setup node or position without an immediate recorded move is not guessable;
  navigation remains available.

## Guess Input

- Capture the same board coordinate produced by an ordinary Kifubara click.
- Validate legality through Kifubara's existing behavior where possible.
- An illegal move does not consume the attempt or reveal the answer.
- Pass is a valid guess when Kifubara exposes an identifiable Pass control.
- A different legal guess is played normally so Kifubara analyzes it. Practice
  owns that resulting child until analysis completes or the attempt is aborted.
- During reveal, only the Game marker has special board behavior; other board
  clicks are ignored by Practice.

## Comparison Rules

- Compare values from the same pre-move position and mover perspective.
- Prefer node-matched full analysis from `kifubara:variation` or an equivalent
  freshness-stamped source.
- The guessed child analysis may be used as the guessed move evaluation after
  converting it to the snapshotted mover's perspective.
- Do not use an unstamped candidate list when navigation may have made it stale.
- If both You and Game have compatible values:
  - positive You-minus-Game advantage: **better**;
  - equal at displayed precision: **equivalent**;
  - negative advantage: **worse**.
- If either value is missing or incompatible: **not evaluable**.
- Preserve the units Kifubara provides; do not mix score lead, win rate, and
  points-lost values in one arithmetic comparison.

## Safety and Compatibility

- Practice may create the same in-memory variation that an ordinary review move
  creates so Kifubara can analyze the guess. It must return to the recorded
  continuation and must not save or export the transient child as a Practice
  side effect.
- If Kifubara cannot remove transient children, the script must clearly treat
  them as ordinary unsaved review variations rather than claiming zero mutation.
- Turning Practice off restores every hidden native element and listener state.
- Late analysis, mutation observers, or navigation events cannot reopen an old
  reveal.
- Manual navigation remains available; guessing is never required to advance.
- Page, focus, visibility, editor-mode, and modal guards should follow the
  existing Kifubara userscripts.
- DOM selectors and bridge payloads must be checked at startup. Unsupported
  versions report an explicit error rather than silently degrading.
- The script must coexist with `kifubara-gamepad.user.js`,
  `kifubara-auto-advance.user.js`, and `kifubara-extensions.user.js`.
- Starting auto-advance or AI playout exits Practice, and enabling Practice
  stops those automated modes through explicit custom events.

## Acceptance Scenarios

1. Enabling Practice in the middle of a game hides the next move and AI hints
   without moving the viewer.
2. Guessing the recorded move advances once, shows no success dialog, and hides
   hints for the following position.
3. Guessing another analyzed candidate reveals You, Game, AI, and an approximate
   verdict on the original board.
4. Guessing an unlisted legal move creates a transient child, waits for its
   native Kifubara analysis, returns to the pre-move node, and compares it.
5. Analysis failure or timeout still returns to the pre-move node and reports
   **Analysis unavailable** rather than zero or a fabricated grade.
6. Forward navigation from reveal follows the recorded continuation and removes
   all temporary markers.
7. Backward navigation, tree selection, game changes, and disabling Practice
   clear stale attempts and restore native UI.
8. Illegal moves do not reveal the answer.
9. Coincident You/Game/AI identities remain readable.
10. Practice cannot enable if required bridge data or spoiler suppression is
   unavailable.
11. Existing userscript tests continue to pass, and focused tests cover every
    state transition and stale-event guard.

## Out of Scope

- Scores, streaks, timers, leaderboards, and performance summaries.
- Forced retry until the recorded move is found.
- Persisting attempts or comparisons across reloads.
- Replacing Kifubara's board, tree, graphs, or navigation.
- Matching KaTrain's retained Key Moments until the core loop is stable.

## Suggested Delivery

1. **MVP:** toggle, spoiler masking, answer snapshot, exact-match advance,
   transient-variation analysis, different-guess reveal, cleanup.
2. **Hardening:** selected-variation support, pass, overlap labels, responsive
   layout, coexistence events, selector/bridge compatibility checks.
3. **Optional:** retained practice moments after the transient analysis lifecycle
   is proven reliable.
