# PROJECT: "Tourist From Almaty" — browser 3D arcade dodging game

## One-liner
A guy from Almaty with thousands of hours in home flight sims steals a real F-22
and flies to Istanbul, dodging NATO missiles, because his favorite lemon cologne
(limonnaya kolonya) ran out. Tone: light, absurd, warm. Not a milsim.

## Tech constraints
- Three.js (latest), Vite, vanilla JS (ES modules). No React, no TypeScript.
- Must run 60fps on a mid-range laptop in Chrome. Keep draw calls low.
- All game logic in small modules: /src/flight.js, /src/fear.js, /src/threats.js,
  /src/radio.js, /src/world.js, /src/ui.js, /src/audio.js, /src/main.js
- Placeholder art first (boxes, flat colors). Real art is a later pass.

## Core pillars (in priority order)
1. FEAR METER is the heart. Everything feeds it or drains it. If fear is boring,
   the game is dead. Prototype it first, tune it constantly.
2. Arcade first-person cockpit flying: roll, pitch, throttle. Forgiving, readable,
   fun in 10 seconds. NOT a simulator — no stalls, no fuel, no complex physics.
3. Radio humor is a survival mechanic, not decoration: answering with a funny
   line lowers fear.
4. Route Almaty → Istanbul, each country = one wave, harder than the last.

## Style rules
- Stylized, slightly cartoonish but adult. Flat/toon shading, strong palettes.
- Cockpit view hides world simplicity: clouds, haze, ground far below as texture.
- Signature item: small yellow bottle of lemon cologne on the dashboard.
  Yellow = accent color everywhere.

## What NOT to do
- No realism features (fuel, damage models, avionics depth).
- No huge asset downloads; procedural / primitive geometry preferred.
- Never break 60fps for a visual effect.
- ART PASSES MUST NOT TOUCH flight.js OR CAMERA PARENTING. The roll/pitch/yaw
  sign chain in flight.js is verified and camera-parenting-sensitive (roll can
  invert silently if the camera stops being a direct, unscaled child of
  `scene`). Visual work (cockpit meshes, lighting, world art) must not add a
  group/scale between camera and scene, and must not edit flight.js's math.