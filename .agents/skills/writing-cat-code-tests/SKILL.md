---
name: writing-cat-code-tests
description: Write focused, useful Cat Code tests. Use when adding or editing a test, fixing a bug, changing observable behavior, or adding regression coverage. Do not use for pure documentation edits or mechanical test renames.
---

# Writing Cat Code Tests

Write the smallest test that would catch the real regression.

1. Find the production entry point and state the bug or behavior the test
   protects. Do not test a helper if the failure lives in its caller.
2. Use the lowest practical layer: a unit test is fine for local logic; cross
   a wiring, process, or DOM boundary only when that boundary is the risk.
3. Cover the main success case and the one failure or edge case most likely to
   regress. Add combinations only when the bug depends on their interaction.
4. Run the focused test and the repository battery appropriate to the files
   changed. State any important layer the test cannot cover, such as GUI or
   live credentials.

For a high-risk regression (security, persistence, process, identity, or
concurrency), also record the entry point, exact failure, proof layer, and
what remains unverified. A temporary mutation check is useful when it cheaply
confirms the test is load-bearing, but it is not required for routine changes.

Do not require a separate test author, verification agent, or evidence template
for ordinary work. Use an independent review only when the change's risk
justifies the extra cost.
