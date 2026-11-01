# Reel standard

How the agents turn an approved carousel into a 30 s vertical reel. The rules come from the agency's
own HyperFrames work (brand films, promos and carousel-to-reel pieces). A client once rejected a reel
because it "looked like a carousel with scroll, not a reel"; everything below exists so that never
happens again.

## Output

- 1080x1920, 30 fps, H.264 yuv420p, exactly 30 s, with music and sound effects (the owner can still swap
  the music for trending audio in the app).
- Safe zone: everything readable stays in x 80–1000, y 280–1470 (the app's UI covers the rest).
- The carousel's visual system carries over: same fonts, colors, logo and photos. The reel is its own
  piece, not the slides played in a row.

## Scenes, not slides

The reel is one piece made from the whole carousel; the slides are not animated one by one. An owner
called a reel built as "one photo and its headline per shot" a PowerPoint slider. In the agency's pieces
a shot is a scene: a container where something new lands every 0.3 to 1.2 s while something underneath
always moves, and products appear together. The code requires at least 3 scenes and at most 3
single-photo shots.

| Scene | What happens |
| --- | --- |
| photo_wall | The hook: every photo of the carousel as tiles on a canvas tilted −12°, rows drifting x 0↔−420 in opposite directions (linear, the whole shot) while the wall zooms 1.25→1 (1.4 s power3.out), a radial shade and the headline on top. |
| product_drop | A cutout product falls from y −1500, rotation −12→0 (0.45 s back.out(1.6)); on landing the frame bumps y [0, 10, −4, 0] (0.25 s) and its shadow grows 0.4→1; a giant outlined word sits behind (scale 1.2→1, linear); up to 3 chips pop 0.4 s apart (back.out(2)) and float y −14 (sine yoyo); the product sways ±2.5°. |
| deck | 2 to 5 products dealt like cards, alternating sides (x ±1300, rotation ±10 → 0, 0.55 s expo.out); the earlier cards recede to scale 0.94 / 0.88, y −32 / −64, shaded 0.4 / 0.68; the label under the deck is pushed out and the new one rises in (0.4 s power3.out). |
| marquee | A hook or a brand moment: rows of a giant word drift against each other (x 0↔−700, linear), alternating filled at 16 % and outlined in the accent; a cutout product floats over them (y −16, rotation 2°, sine yoyo). |
| grid | 2 to 4 products land in a grid one by one (scale 0.5→1, rotation ±6→0, back.out(1.7), 0.35 s apart) with optional labels; the grid leans in (scale 1→1.05). |
| stack_list | 2 to 4 points land as slabs, one per beat (y −1500, rotation ±3, 0.32 s power3.in); each landing bumps the frame and squashes the slabs below (scaleY [1, 0.9, 1.03, 1]). |

Film grain moves under everything (steps) and stops before the closing hold.

The code asks for at least 3 scenes of at least 3 kinds, and the director designs the sequence for the
brand: a calm brand gets 6–7 longer shots with soft transitions; an energetic one 7–9 shots with hits.

## The brand's look

The reel uses the carousel's system, which comes from the brand's own website: the same ground (a
gradient with grain when the site has one), corners, alignment, letter spacing, case, button style, and
products loose on the ground when the site shows them that way (a studio shot loses its plain background).

## Sound

- Music: the reel director picks genres, energy, a tempo range and a mood. The code takes tracks of those
  genres from Mixkit's free library (`data/music.json`, built by `scripts/build-music-catalog.mjs`; no
  attribution required), or Openverse's CC0 / CC BY music, measures the tempo and beat of each, and keeps
  the steadiest 30 s window starting on a beat. Every cut moves to the nearest beat (half-time for fast
  tracks). Fade in 0.25 s, fade out over the closing hold.
- Effects (Mixkit, free): a whoosh 0.32 s before every transition, an impact when a product lands and on
  the logo, pops for chips and grid tiles, thuds for slabs, a riser that crests on the end card.

## Structure

- A beat grid of 0.5 s (120 BPM). Every cut and key hit lands on a beat.
- A new shot every 3–7 s: 6 to 9 shots in 30 s, regrouping the carousel (products together in a deck,
  the cutouts dropped, the perks stacked), and the close is an end card.
- **Frame 0 already shows the hook headline**: it is the thumbnail. Motion starts by 0.1 s.
- Every shot moves inside: the photo always has a camera (slow push-in, pull-out or pan, linear for
  the whole shot; the hook gets a fast zoom that settles).
- Order inside a shot: background, photo, headline, then details, staggered 0.12–0.2 s. At most two
  things animate at once besides the camera.
- Reading time: each phrase holds still at least 0.5 s + 0.3 s per word.
- The last 1.5 s are completely still: the end card with the logo is the closing hold.

## Transitions (one per cut, never the same twice in a row)

| Preset | What it does |
| --- | --- |
| carry | an accent bar at the center grows to the full width, then the full height (0.22 + 0.28 s expo.inOut): the panel carries the cut and wipes up (0.4 s power3.inOut) to reveal the next shot |
| iris | the next shot opens as a circle from the center, 0 → 1700 px, 0.38 s power3.in |
| zoom_through | out: scale 2.4, blur 10, 0.32 s power3.in · in: from scale 0.62, blur 10, 0.38 s power3.out, 0.14 s later |
| whip | out: x −320, skewX −8, blur 16, 0.30 s power3.in · in: from x 320, skewX 8, blur 16, 0.36 s power3.out |
| clip_wipe | the new shot is revealed with clip-path inset, 0.8 s expo.inOut, led by a 6 px accent bar; the old one is pushed x −70 |
| band | a full-frame brand-color band crosses the frame (0.75 s power3.inOut) and hides the cut |
| panel | a brand-color panel rises and becomes the next background (into the end card or a type shot) |
| blur_crossfade | out: blur 14, scale 1.04 · in: from blur 14, scale 0.97, 0.55 s power2.out |
| cut | a hard cut on the beat |

## Text

- Headlines: max 7 words per shot, one emphasis word, 92–128 px, line-height 1.05, letter-spacing −0.02em.
- Presets: **words** (word by word: yPercent 60, blur 8 → 0, 0.42 s power3.out, stagger 0.07),
  **rise** (each word rises from a mask: yPercent 110 → 0, 0.9 s power4.out, stagger 0.09),
  **slam** (the words come in, then the emphasis word slams: scale 1.55, blur 14 → 1, 0.42 s expo.out).
- Emphasis: **marker** (an accent box grows behind the word, 0.45 s power2.out, 0.28 s after the
  line), **underline** (an 8 px accent bar) or **color** (the word in the accent color).
- Text that landed never moves again while it is read. Text never covers a face or the subject.
- Every word comes from the carousel's own text: no new facts, prices or claims.

## Photos

- Real photos of the business only, full-bleed with a scrim gradient on the text side, or in a
  window (mask reveal 1.1 s expo.out with the photo scaling 1.18 → 1 inside, and an offset accent
  outline 26 px away).
- Website images with text baked in are softened and shaded so their text never competes.

## Logo and close

- The logo is built, never just faded in: scale 1.35, blur 12 → 1, 0.5 s expo.out, with an accent ring
  that expands and fades. It stays: it is the closing hold.
- The call to action can be a pill that pops in (back.out(2)).

## Banned

- One continuous pan through the slides (it reads as a scrolling carousel).
- Everything entering with fade + slide-up; the same transition twice in a row.
- Headlines that keep moving after they land; text moving while it is read.
- A black void with small things in the middle; glow, particles, purple gradients.
- The logo in a corner; three cards in a row; emoji glyphs; continuous glitch.
- More than about 20 % of the frame covered by text.

## Review

The reel critic gets frames at the thumbnail, at the reading point of every shot and at the end, plus
what the code measured (length, still ending). It answers: hook_frame0, motion_graphics (not a
slider), readable, brand, nothing_weird, end_card. The safe zone is not judged: the layout guarantees it. The run writes `SPEC.md` (goal, output,
time, look, shots, banned, QA times) and `REVIEW.md` (decisions, measured, weak spots) next to the
reel, like every piece the agency delivers.
