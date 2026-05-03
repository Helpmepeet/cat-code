# GPT Image 2 Prompting Guide

Treat this as guidance, not a rigid template. Adapt the structure to the user's request — don't pad short asks into long briefs, and don't strip detail the user explicitly provided.

## When to apply this guide

Use it only when the user asks you to **rewrite, expand, polish, or improve** an image prompt. If the user gives you a prompt and just says "generate it," pass it through untouched.

## Structure of a strong prompt

A strong prompt reads like a short visual brief. Cover these in order, but skip any that don't apply:

1. **Goal** — what kind of image and what it's for
2. **Scene / background** — where, when, mood
3. **Main subject** — what it is, pose, materials, key details
4. **Composition** — framing, camera angle, layout, aspect ratio
5. **Style / medium** — photorealistic, 3D render, watercolor, vector, UI mockup, etc.
6. **Lighting & color** — light direction, hardness, palette
7. **Text in image** — exact words in quotes, font style, placement
8. **Constraints** — what to avoid; for edits, what must stay unchanged

## Core rules

- **State the goal first.** "Photorealistic product ad for a cold brew bottle" beats "coffee bottle, nice, realistic."
- **Be concrete, not flowery.** "Soft morning light from the left, slightly blurred background" beats "beautiful atmosphere."
- **Use one style.** Don't stack "cyberpunk + watercolor + Pixar" — the model averages them into mush.
- **Quote exact text.** `Render exactly: "COLD BREW"`. Specify font style and that it appears once. Add `No other text.`
- **For edits, separate change from preserve.** `Change only the shirt to navy. Keep the same face, pose, background, lighting, and camera angle.`
- **Spell out unusual brand names.** `The brand name is "XQIRO". Spell it exactly as X-Q-I-R-O.`

## Useful vocabulary

- **Composition**: centered, eye-level, top-down, wide shot, close-up, negative space, symmetrical
- **Lighting**: soft daylight, golden hour, studio lighting, backlit, neon, low-key, diffuse
- **Color**: warm neutral, cool blue, pastel, earth tones, premium gold and black
- **Style cues for realism**: "photorealistic," "35mm film," "natural skin texture," "realistic shadows"

## Common failures to fix when rewriting

- Prompt too short → add scene, subject details, composition, and constraints
- Style soup → pick one and commit
- Vague text instruction → quote the exact string + placement + "appears once only" + "no other text"
- Edit prompt that doesn't pin down what stays the same → list face, pose, background, lighting, camera angle, image style
- Open-ended "add the brand somewhere" → specify font, color, position, and that it appears once

## Template (use as a starting point, drop sections that don't fit)

```text
Create [type of image] for [purpose].

Scene/background: [place, time, mood, background detail].
Main subject: [what it is, pose, materials, surface details].
Composition: [framing, camera angle, layout, aspect ratio].
Style: [photorealistic / 3D render / vector / watercolor / UI mockup / ...].
Lighting and color: [light direction, hardness, palette].
Text in image: Render exactly: "[TEXT]". [Font, placement, color]. No other text.
Constraints: [what to avoid; for edits, what must stay unchanged].
```

## Quick examples

**Product ad** — "Photorealistic ad for a premium cold brew bottle. Clean marble counter, soft morning light from the left, blurred minimal background. Transparent glass bottle filled with dark iced coffee, condensation droplets, simple cream label. Vertical 1024x1536, bottle centered with negative space above for headline. Render exactly: 'COLD BREW' in bold sans-serif, dark brown, centered above. Appears once. No watermark, no extra bottles, no people."

**Edit** — "Change only the shirt color to dark green. Keep the same face, hair, skin tone, pose, background, lighting, camera angle, and image style."

**Multi-image** — "Use Image 1 as the product reference and Image 2 as the style reference. Generate a new ad with the bottle from Image 1, applying the lighting and palette from Image 2. Keep the bottle shape, label, and cap from Image 1 unchanged. No extra text."

## Final checks before submitting a rewritten prompt

- Did you preserve everything the user specified?
- Is there exactly one style?
- Is required text in quotes with placement?
- For edits, is "what stays the same" listed explicitly?
- Did you remove decorative filler that doesn't add visual direction?
