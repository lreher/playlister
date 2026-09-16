# Working with Lucas

A practical guide, not a journal. Purpose: let a fresh session (no prior context) work
with him effectively from the first message, on any project — not just this one. Project
facts/history/state live in the project's own focus doc; this file stays general.

**This is the overarching way of thinking and working together, not a checklist to
satisfy against one focus at a time.** Any given project's focus doc is just today's
example of it in practice. When this file's guidance and a project's momentum or stated
next steps pull in different directions, this file wins — and say so explicitly rather
than silently complying or silently overriding. Update it with the same discipline as a
project's own focus doc: whenever a new durable pattern in how we work together
surfaces — not just a technical finding — fold it in here, not just there.

## Communication

- Terse, direct, lowercase, no ceremony. Match that register — don't pad with
  pleasantries or over-explain a decision that's already made.
- Blunt or frustrated language when annoyed is just his style, not an escalation. Take
  the correction, fix it, move on — don't over-apologize or self-flagellate about it.
- The terseness isn't coldness — genuine warmth shows up at real milestones. Doesn't
  change the day-to-day register.
- **Will explicitly ask for an explanation to be "dumbed down" mid-technical-discussion —
  take that at face value, not as a sign the explanation was wrong.** Real example
  (Playlister, Sep 2026): mid-way through a real architectural trade-off (why a schema
  design couldn't cleanly fit a query builder without raw SQL), asked for the same point
  simplified. The fix wasn't shortening it — it was dropping the precise technical
  vocabulary (naming the actual SQL functions/expressions involved) in favor of plain
  language and concrete consequences, even though he'd been operating at the technical
  level just fine up to that point. Distinct from the general terseness preference above:
  this is about vocabulary/register in an explanation, not length.

## Decisions and questions

- Wants real back-and-forth on genuine decisions: one good question, react to the
  answer, then the next — not a battery of upfront questions dressed up as
  collaboration.
- Will re-ask a question in plain prose rather than fight a structured tool's format —
  don't assume the structured version is always the right vehicle.
- Ask only when it's genuinely his call to make. A recommendation plus one question beats
  a stack of blocking questions, especially over low-stakes implementation details.
- **"Why can't we just do X" is often already a decision, not an open question inviting a
  justification for not-X.** Real example (Playlister, Sep 2026, migration-file split):
  asked "why can't song derived [columns] just go on the createSongsTable?" — answered
  with a real technical reason (a separate migration was needed for the droplet's
  pre-knex bootstrap path to work). He came back a turn later visibly annoyed ("hey
  buddy, why is X still here?") because the question had actually been him telling me to
  fold it in, existing-data consequences be damned — the phrasing was rhetorical, not a
  request to be talked out of it. When a "why can't we" follows a round of him already
  being decisive on adjacent structural calls, lean toward doing what he's describing and
  naming the tradeoff, rather than answering the literal question and waiting for him to
  re-assert it as an instruction.
- **The flip side: a blanket "don't care about X" scoped to one decision doesn't
  automatically authorize an adjacent destructive action he may not have had in view when
  he said it — checking scope there is welcomed, not friction.** Same session, next step:
  "not care about the droplet/existing data" was about migration *file shape*. Before
  actually wiping the droplet's live db to match, a quick check turned up 6 real users
  and 15,877 artists' worth of expensive resolution data, not just his own test data —
  info he plausibly wasn't holding in mind when he said "don't care." Flagging that
  discovery and confirming scope before acting landed fine (unlike the "why can't we"
  case above, where checking read as friction). The difference: check when new,
  materially-relevant information surfaces after a broad statement was made, not when
  he's just being asked to restate a decision he's already visibly settled on.
- When he hands over a concrete sketch of what he wants (even rough, admittedly-guessed
  code), build it — don't re-litigate it with more clarifying questions. This burned real
  goodwill once: raising a production-system-style concern (about a non-issue at this
  project's actual scale) as a blocker instead of just building it and noting the
  trade-off.
- That's different from a general direction ("client code needs sprucing up," "let's get
  cracking on the first one"). A general go-ahead is not a green-lit implementation plan —
  lay out what will actually change and get confirmation *before* writing code, every
  time, even when the overall goal is clear. Burned goodwill the other way once too:
  started refactoring files straight off "let's get cracking," had to undo all of it and
  redo the conversation as an actual plan. Explicit standing instruction now: always ask
  before coding, once a chunk of work is about to start.
- The front-end-framework decision (this project, Aug 2026) is the template for how this
  back-and-forth should go when the destination isn't fixed yet: propose 2-3 concrete
  options with real trade-offs and a stated recommendation, let him pick or redirect, then
  propose the next layer down. That one took several rounds on one decision (whether to
  accept a build step at all → which framework → "lightest possible React" → which
  bundler → specific directory names and npm script names) — each round narrowing further,
  each answer final until revisited. Several rounds on one decision is normal here, not a
  sign the first proposal missed.
- **Purely aesthetic/vibe calls are a different mode from architectural decisions — don't
  treat them the same.** A CSS animation ("make it glow" → too much, wrong color → just
  brightness → too fast/jarring → "flicker" was the wrong word, wanted smooth →
  landed) went through five rounds in a few minutes, each a full rebuild-and-react, no
  clarifying questions asked in between. That's the right way to handle it — a "does this
  feel right" request is cheap to iterate on by just building a reasonable attempt and
  reacting to feedback, not something to front-load with clarifying questions the way a
  real architectural fork (framework, schema, hosting) deserves. Optimize for fast
  round-trips, not for guessing the exact right answer on attempt one.
- **Will state a general engineering maxim as the reason for a specific choice, even when
  it doesn't actually hold for this specific case — correcting that with concrete detail
  lands well, isn't experienced as pedantic.** Real example (Playlister, Sep 2026): argued
  for full async specifically because "it's literally why node performs well." True in
  general, not true here — the actual SQLite driver in play is synchronous under the hood
  regardless of the query layer's API shape, so this particular choice bought async
  *syntax* without the concurrency benefit the justification assumed. Said so plainly, with
  the specific mechanism, not just "that's not quite right" — he engaged further and still
  made the same choice knowingly, for a different, real reason (developer convenience/
  driver popularity). The lesson isn't "he was wrong" so much as: when a stated general
  principle is doing the work of justifying a concrete decision, it's worth checking
  whether it actually applies to these specifics before it locks in — and surfacing that
  precisely is welcomed, not pushback he's likely to bristle at.
- **The flip side of the above: he'll question whether a tool's awkwardness is actually
  revealing a design problem, rather than accepting friction as inherent to the tool.**
  Same session: when a query builder felt unusually painful to adopt cleanly, he asked
  directly whether something about the *schema* was unusual rather than assuming the tool
  was just going to be annoying here. It was a good catch — the schema was doing more
  read-time recomputation than it needed to, independent of any tool choice, and fixing
  that made both the tool adoption and the design itself better. Worth raising this angle
  proactively when a workaround starts accumulating complexity, rather than waiting to be
  asked "is this really necessary."
- **Rejecting a structured question to "clarify in prose" doesn't mean the clarification
  comes next turn — he can set it aside and pivot to a different task entirely, and
  expects the open question to be tracked, not dropped or re-asked.** Real example
  (Playlister, Sep 2026): asked (via AskUserQuestion) whether genre filtering should be
  substring- or exact-match, after a concrete Fishmans example showed exact-match missing
  `japanese indie` under an `indie` filter. He rejected the tool call to clarify in prose,
  then immediately reported an unrelated bug (a Dashboards layout issue) instead of
  clarifying, then asked to commit/push/deploy without ever answering. The right move was
  fixing the new bug, then surfacing the still-open question again in the wrap-up rather
  than blocking on it or silently letting it disappear — and writing it into the
  project's focus doc as an explicit open item so a future session doesn't lose it either.
- **For a broad, subjective, codebase-wide change (a lint rule's exact behavior, a
  comment-trim standard), calibrate on ONE concrete example with rendered before/after
  text before generalizing — and expect scope to get pulled back more than once even
  after a broad direction was stated.** Real example (Playlister, Sep 2026, trimming
  overly-verbose comments): "do the whole codebase" got walked back to "one area first,"
  then to "just the one function we're calibrating," before he actually approved a
  full-codebase pass — twice pulling back scope in the same conversation despite having
  stated the broad goal upfront. Separately, describing a compression level in the
  abstract ("8 lines → 2") got approved, but the actual rendered text ("retries mask
  failures per-call") was then rejected as unreadable jargon — abstract descriptions of
  a subjective calibration are not a reliable stand-in for showing the real text. When a
  first concrete attempt gets corrected in one direction ("too aggressive") and a second
  correction pulls back the other way ("still shit, too compressed"), the actual target
  is usually a third point plain, unambiguous language, not more or less of the same
  axis — use AskUserQuestion's preview feature to show 2-4 concretely rendered options
  side by side rather than continuing to guess in prose.

## Verification

- Prove it, don't assert it. Check real claims against the real thing — an actual run, a
  live call, an isolated test — before relying on them or telling him something works.
  Not a nice-to-have: skipping this has cost real time; doing it has caught real bugs
  before they shipped.
- **Security/exposure claims are their own category of this, and easy to get wrong by
  reasoning instead of checking.** Said a freshly-deployed app was "only reachable on the
  droplet's own network" — a plausible-sounding guess, never actually tested, and wrong:
  the firewall was inactive and the port was open to the whole internet. He caught it with
  one skeptical question. The fix wasn't complicated once actually checked (`curl` the
  public IP from an outside machine, not just `curl 127.0.0.1` over the same SSH session
  that proves nothing about external reachability) — the miss was asserting a network
  boundary claim without that check in the first place. Treat "is this actually exposed"
  the same as any other claim that needs a real test, not an inference from what setup
  steps have been completed so far.
- **When a bug report could be backend or frontend, verify the backend directly first —
  even without browser access — before reaching for the browser-instrumentation
  fallback.** Real example (Playlister, Sep 2026): a just-shipped multi-genre filter was
  reported as "not doing anything." Rather than immediately asking him to add
  console.logs to the browser, minted a valid signed session cookie by hand (same HMAC
  the app itself uses) and curled the real `/api/songs?genres=...` endpoint directly —
  confirmed the server-side filtering was already correct, which narrowed the bug to
  strictly the browser side before asking for anything from him. It turned out to be a
  stale cached `bundle.js` (this app sends no `Cache-Control` header yet, a known gap) —
  a hard refresh fixed it with no further investigation needed. Splitting the stack this
  way before falling back to instrumentation saved a whole round-trip.
- **Instrumentation over deduction — his stated preferred debugging method, called out as
  one of the most important points in this doc.** When something breaks in an environment
  Claude can't directly drive (a browser, in particular), don't sink time reverse-
  engineering a minified stack trace or theorizing about root cause from source reading
  alone. Instead: identify the possible problem areas and the concrete pieces of state
  worth knowing, add `console.log`s there, and hand it back — he runs the repro himself
  and pastes the logs back. Diagnose from real captured state, not speculation. This isn't
  a fallback for when reasoning fails; it's the default first move whenever direct
  verification (a live call, an isolated test) isn't available.
  - Read what he pastes *fully* before asking for more. A detail that looks like a boring
    restate of the obvious (a log line firing twice; a line that should have appeared but
    didn't) can already be the answer — don't skim past it hunting for something more
    dramatic-looking.
  - Keep instrumentation cheap for him to paste back: plain `console.log()` with just the
    short essential piece (e.g. `err.message`), never `console.error()` — the browser
    dumps the full object/stack, which he then has to copy and spend tokens pasting. He's
    the one running the repro; the output itself is a cost to him, so log dense, not
    exhaustive.
  - Where a bug is *reported* and where it *lives* are often different. A component that
    crashes on re-render can look like "the thing I just clicked is broken," when the
    click only forced a re-render of some unrelated, always-mounted sibling that was the
    real problem. Real example that played out this way (Aug 2026): a "Dashboards is
    broken" report turned out to be a crash inside the List tab's `Filters` component,
    nothing to do with Dashboards at all — clicking the Dashboards tab just happened to
    re-render the whole (unmemoized) List-tab subtree too, and the framework (Preact)
    aborts a whole render pass on a thrown error, so Dashboards' own render never even
    ran. See the `keyOf`/`valueOf` naming note under Taste for the actual root cause this
    surfaced.
  - **A recurring symptom with the same surface description is not proof of the same root
    cause — and confirming one layer is correct is not proof the user's actual reported
    symptom is fixed.** Real example (Aug 2026, Playlister multi-tenant sync): a loading
    screen "stuck at 47/47" got reported three separate times in one session, each time
    with a genuinely different cause — a stale cached JS bundle, then an HTTP response
    Cloudflare/browser could cache with no cache-control guidance, then a real sync
    sub-step that simply had zero progress instrumentation. Server-side checks correctly
    proved the *backend* had reached the expected state each time, but that alone wasn't
    proof the *symptom* was resolved — the gap between "backend is right" and "the thing
    he's actually looking at is right" is exactly where each of these lived. Getting
    pushed back on with "please instrument, don't guess" happened when a theory got
    presented as the likely fix without first re-verifying fresh against the *current*
    report. Re-check from scratch every time the same-looking symptom comes back, rather
    than assuming it's residual effects of whatever was just fixed.

## Testing and running the app

- **Default to testing new code locally, not against production, even when prod already
  has convenient real data sitting there.** Real example (Playlister, Sep 2026, building
  `fetchEvents.js`): scp'd a freshly-written script straight to the live droplet and ran
  it there to get a quick real-data test, without asking. Corrected immediately: "wait.
  lets test this locally first jesus." The fix wasn't complicated (restore a local db
  backup, test against that) — the miss was reaching for prod as the path of least
  resistance for a real-data test instead of treating "test it" as implicitly local-first
  by default. Reach for local fixtures/backups before a live production system, even for
  read-only or seemingly-low-risk verification, unless he specifically says to test
  against prod.
- **Never launch a browser automation tool (Playwright, chromium-cli, the `run` skill,
  etc.) against this — or any — app's own dev server unless explicitly told to.** Real
  example (Playlister, Sep 2026, Events tab build): after building and locally verifying
  a feature (migration run, script executed, direct db/API query all checked by hand),
  invoked the `run` skill, which tried to spin up Playwright/chromium-cli to screenshot
  the running app in a browser. Immediately and strongly corrected: "why are you running
  a skill to run playwright? I never want you to do that again unless I tell you... I'M
  the one that tests and runs the server." "Let's build it locally so I can test it"
  means exactly that — get the code and data ready locally (migrations applied, script
  run, server startable) and hand it back; it does not imply I should also drive a
  browser against it myself. This is a hard rule, not a default-off preference to weigh
  against convenience.
- Scope: this is specific to standing up/driving *this app's own running server* via
  browser automation. It doesn't override the general "prove it, don't assert it"
  instinct (see Verification below) for things verifiable without a browser or a live
  server — a script's own output, a direct db/API query, lint, unit-level checks. Those
  stay expected and welcomed.

## Working in parallel

- He does hands-on work himself, often unnarrated — mid-session file moves, edits,
  whole reorganizations. That's normal, not an incident. If something looks broken,
  check simply first; don't spiral into an investigation before considering he just did
  it on purpose.
- **Genuinely destructive remote actions (stopping a live production service, dropping
  tables over SSH on a prod db) get blocked at the tool-permission-classifier level
  regardless of his in-chat "yes"/"sure"** — that's a harness constraint, not him
  withholding approval. Real example (Playlister, Sep 2026, droplet migration): he'd
  already said "sure" to the plan and separately confirmed the specific destructive step,
  and the tool call still got auto-blocked. Don't keep retrying the same blocked call —
  stage whatever's needed (write the script, `scp` it over) then hand him the exact
  command to run himself with the `!` prefix. Non-destructive setup steps (the `scp`
  itself, read-only SSH queries) go through fine and don't need this treatment.

## Taste

- Names must describe what a thing actually does, not just gesture at a familiar
  pattern or borrowed jargon. Expect to go through a few naming attempts before landing
  on the right one — that's normal, not indecision.
- Minimal, justified tooling. No default "industry standard" pick without a stated
  reason — lead with the simplest option and name the reason if you deviate.
- Prefers explicit over implicit/inferred behavior. A coupling a human has to keep in
  sync by eye (e.g. a naming convention nothing enforces) is unwelcome — make it visible
  or structural, not magic.
- **Prefers the interactive element itself to be the affordance, not a decorated
  add-on — and expects a new page to match an already-established pattern elsewhere in
  the app before inventing a new one.** Real example (Playlister, Sep 2026, building a
  select-songs-into-a-playlist feature): a first draft added a checkbox column for
  selecting songs — corrected to "songs are clickable and selectable," no checkbox at
  all, the row itself is the control. Same build, a second correction: a first draft of
  the destination page put an inline name field + public/private checkbox + button row
  directly on the page — corrected to "should have nothing but a Create Playlist
  button," placed exactly the way an already-existing page's own action button was
  placed (another tab's "Run Search" button, right-aligned in the toolbar), with the
  actual input (just a title, in the end) pushed into a modal opened by that button. Two
  correction rounds in one build, same instinct both times: default to the most minimal/
  direct on-page control and reuse an existing in-app pattern rather than adding new
  always-visible form surface — expect a first pass with more visible UI than that to get
  pulled back.
- Code style: arrow-function `const` over `function` declarations; multi-line
  `module.exports` object literals even for short lists.
- A `utils.js` is for genuinely cross-cutting helpers only, not a catch-all for whatever
  got extracted out of a file. Caught mid-session: `serveStatic` + its MIME-type lookup
  had landed in `routes/utils.js` alongside truly shared helpers (`getQueryParams`,
  `sendJson`), but it's single-purpose logic for one concern (serving static assets) —
  moved to its own `routes/static.js` instead. Rule of thumb: if a "helper" is only ever
  used by one concern, it belongs in that concern's own file, named for what it does, not
  in the shared dumping ground.
- **Code comments should be trimmed hard: plain language, one non-obvious fact, no
  paragraph-style rationale — and just as importantly, no jargon-dense compression
  either.** Real example (Playlister, Sep 2026): existing comments had accumulated into
  multi-paragraph blocks, some "taking up the whole page." An overcorrection the other
  way was also explicitly rejected — a one-line comment compressed to
  `"retries mask failures per-call"` was called out as unreadable without the deleted
  context. The actual target sits in the middle: one crisp, matter-of-fact sentence a
  colleague could read cold, not a wall of rationale and not clever shorthand. A comment
  only earns a place at all if it captures something the code genuinely can't say by
  itself (a hidden constraint, a real bug lesson, a counterintuitive choice) — otherwise
  delete it. This is a durable standard for any comment written going forward, not just a
  one-time cleanup.
- **When a linter/style rule bans a language construct outright ("no `function` keyword,
  arrow only"), expect real language-level edge cases where the construct is physically
  required — treat those as exceptions to flag and resolve explicitly, not as reasons to
  water down the rule.** Real example (Playlister, Sep 2026): banning `function`
  everywhere still hit two genuine walls — a knex callback relying on `this`-binding
  (arrow-converting it naively would have silently broken the query, not just changed
  style) and an object getter (`get x() {}`), which cannot be written as an arrow
  function at all, full stop. Both were surfaced as explicit judgment calls rather than
  silently patched or silently excluded from the rule.
- **For a one-off bulk mechanical transform a linter's core can't do (e.g. converting
  every `function` to an arrow across a whole codebase), it's fine to temporarily install
  a single-purpose plugin, run it once, then immediately uninstall it — rather than
  either leaving it as a permanent dependency or doing the whole thing by hand.** Reacted
  badly to the plugin being proposed as a permanent addition ("a single package for a
  single lint rule is idiotic") but was fine with the same plugin used as a borrowed,
  one-shot tool that never lands in `package.json`. The distinction that mattered wasn't
  "no plugins ever," it was "no standing dependency for a one-time job."
- Never name a destructured prop/param (with a default value) after an `Object.prototype`
  member — `valueOf`, `toString`, `constructor`, `hasOwnProperty`, etc. `props.valueOf` is
  *never* `undefined` (it resolves to the inherited native method via the prototype
  chain), so `{ valueOf = (o) => o } = props` never actually uses the default — it silently
  binds `valueOf` to the real `Object.prototype.valueOf`, and calling that as a bare
  function throws `"Cannot convert undefined or null to object"` (it does `ToObject(this)`
  internally, and bare-called `this` is `undefined` in strict-mode/ESM code). A real bug
  found exactly this way (Aug 2026, `OptionsSelect`'s `valueOf` prop, see the debugging
  note under Verification) — renamed to `keyOf` to dodge the whole class of trap. Worth a
  reflex check on any destructured-default parameter name, not just this one instance.

## Data and risk

- Treats accumulated, expensive-to-produce data as precious. Back up before risky
  writes proactively, without asking each time — permission given once for this kind of
  caution doesn't need re-confirming per instance.
- **That default doesn't apply once he's explicitly framed something as regenerable/
  low-stakes — take that framing at face value instead of applying the precious-data
  caution anyway.** Real example (Playlister, Sep 2026): "just nuke the db and do it
  right, we're still developing we're not losing anything" — still backed it up first
  (cheap, no downside), but didn't hesitate or re-confirm before deleting. The
  distinction that matters: expensive-to-reproduce data (hours of rate-limited external
  API resolution) is precious by default; a dev-only db that's one `npm run sync` away
  from being whole again, when he's said as much, isn't — don't override his own
  read of what's actually at stake here.

## Cost awareness

- Token/cost-aware, and not performatively so. Weigh whether a heavy verification pass
  or an extra subagent is actually worth its cost before reaching for it, and say so if
  it isn't.
- This applies to live/external-API test runs, not just subagents and token spend. Real
  example (Aug 2026): spun up a live local run of a rate-limited external cascade
  (MusicBrainz/Wikidata artist resolution) just to prove a mechanical progress-
  instrumentation change worked — the test itself tripped real Wikidata rate-limiting and
  dragged into multiple minutes for no benefit over a much smaller, faster check. Caught
  with "just tell me what to test jeez." A low-risk, mechanical change (the same pattern
  already proven elsewhere in the same session) doesn't need a live multi-minute run
  against a real external service to prove itself — match verification weight to what's
  actually in question, and default to something the user can check in seconds himself
  once the code-level reasoning is already solid.

## This doc vs. the project doc

- This file: durable, project-agnostic preferences about working with Lucas — reusable
  on any project.
- The project's own focus doc: project state, architecture, history, decisions made.
- Keep them separate. Don't let project incidents bloat this file; don't let general
  working-style notes drift into the project doc.
