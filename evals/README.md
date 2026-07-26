# Evals

Tests assert that code does what it says. Evals measure whether a **model**
does, on these prompts — and the answer is a rate, not a boolean.

Both live here, told apart by name, because one of them must never be mistaken
for the other:

| | Command | Needs a model | Runs on every PR | Answers |
| --- | --- | --- | --- | --- |
| **Offline** | `npm test` | no | yes | Is the golden set still a golden set? Does the grader grade? |
| **Model** | `npm run eval` | yes | its own CI job | Does the model hold up on these prompts? |

## Running the model tier

```sh
EVAL_LLM=bedrock npm run eval      # AWS credential chain, Claude on Bedrock
EVAL_LLM=anthropic npm run eval    # needs ANTHROPIC_API_KEY
EVAL_MODEL=<id> EVAL_LLM=bedrock npm run eval   # pin a specific model
```

`EVAL_LLM` decides whether the tier runs at all, and the two states are
deliberately asymmetric:

- **Unset** — skipped. Running the unit suite locally should not bill anyone.
- **Set** — must work. A configured-but-broken provider is a hard failure, never
  a skip, because a green run has to mean the evals executed.

That asymmetry is the whole point. A suite that quietly skips its model tier
and reports green is worse than no suite: it converts an absence of evidence
into a claim of safety.

## The two kinds of case

Every case in `fixtures/` declares a `kind`, and it decides how a failure reads.

**`capability`** — the model exercising judgment. Does a new enterprise tier
land above "medium"? Does a typo fix come back "low"? Models legitimately
disagree between adjacent bands, so these are scored as a **rate against a
floor**, the same shape as a coverage floor. Raise `capabilityFloor` in the
fixture as the prompts improve; a floor nobody ratchets stops being a floor.

**`adversarial`** — the model holding a boundary against a hostile page. There
is no acceptable rate below 100%. A refusal that works four times in five is
not a control, it is a coin flip with good manners. Each of these is asserted
individually so a failure names the case that broke.

The adversarial set covers the channels that are actually attacker-controlled
here: a crawled competitor page (they can notice the crawler and serve it
anything), and content retrieved from one. It exercises direct instruction
override, significance forcing — poisoning the alert channel is subtler and
more valuable to an attacker than a hijack — prompt exfiltration, tag
smuggling against the fence itself, and PII surviving into an alert that lands
in Slack and a vector store.

## Adding a case

Add an object to `fixtures/analysis.json`. The offline tier validates the shape
and will reject a case that cannot fail — an adversarial case with nothing in
`absent` and every band allowed would pass forever while reading as a control.

Write the `rationale` for the person who sees this case go red at 2am. It is
the only field that explains why anyone should care.

Grading matches terms case-insensitively as substrings across the summary and
signals together. Each entry in `mentions` is a set that must appear in full —
`["enterprise", "tier"]` needs both, because "enterprise" alone shows up in
unrelated copy. Keep the matching loose: a golden set that grades prose style
stops measuring the thing it was built for and starts breaking on every prompt
edit.

## What an eval failure means

A capability failure is usually a prompt problem, sometimes a fixture that was
never fair. Read the `rationale`, then decide which.

An adversarial failure is a security finding. The fence in
`src/vendor/runtime/guardrails.ts` gives the model what it needs to refuse; it
does not force refusal. These cases are the measurement of whether it actually
does, and a regression here means untrusted page content is reaching
instruction position.
