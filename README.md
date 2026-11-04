# Lumi · carousel agent

**A crew of agents on Meta's models that turns a business website into an on-brand Instagram/Facebook carousel, designed layer by layer in GIMP and checked by its own critic.**

A small business that can't pay an agency gives its website and a language. Nothing else: the run is automatic. The agents work the way an agency's production team does: they read the brand, plan with the real material there is, design in a real editor, check their own work, take the owner's revisions and deliver.

The agents don't generate the slides as images. They use the business's **real photos and logo**, find the subject with **SAM 3.1** so it is never cut or covered, and build every slide in **GIMP** with real layers. Code measures what a model can't be trusted with (geometry, contrast), and models judge what code can't (brand, taste, meaning).

## The flow

| Step | Agent | Model | What happens |
| --- | --- | --- | --- |
| 1. Intake | Analyst | Muse Spark (vision) | Reads the website as a visitor sees it (headless Edge, desktop and phone), downloads every image at full size and sorts it: logo, products, photos, banners. Photos with the product cut by their own edge are marked unusable. |
| 2. Strategy | Director | Muse Spark | Picks the format for the business (catalog, proof, benefits, how it works, offer) and plans the slides and the caption from real facts only. |
| 3. Art direction | Art director | Muse Wonder (vision) | Sets one visual system from the brand's own website: composition, personality, fonts, logo treatment, and a decor kit that **Muse Image** generates once. |
| 4. Production | Templates + SAM | SAM 3.1 | Each 1080×1350 slide is built in GIMP over MCP. Slide 2 is built first as the master; the others follow it, in parallel. |
| 5. QA | Lint, critic, fixer | Muse Spark (vision) + code | The lint measures overlaps, margins, centering and faces on the GIMP layers. The critic answers a yes/no checklist. A failed check becomes a fix from a fixed contract (`smaller_headline`, `text_above_photo`, `another_photo`…) and the slide is rebuilt. The best round is kept, not the last. Then the whole set is reviewed on one contact sheet. |
| 6. Client revision | Owner → fixer | Muse Spark | The owner asks for changes in plain words ("bigger headline"); they become settings, the slide is rebuilt and the critic checks they were made. |
| 7. Delivery | System | | Everything ships in one ZIP: PNGs, editable XCFs and the caption. |

```
website + language
      │
      ▼
  Analyst ──► Director ──► Art director ──► decor kit (Muse Image)
                                │
                                ▼   master slide first, then the rest in parallel
         SAM 3.1 ──► template in GIMP (MCP) ──► lint ──► critic checklist
                          ▲                                   │
                          └────── fixer (fixed contract) ◄────┘   best round kept
                                │
                                ▼
                     set review on a contact sheet
                                │
               owner revisions ─┤
                                ▼
                     ZIP: carousel + caption
```

## It learns what the owner likes

The **Feed** shows every carousel like a Meta feed (feed and grid), with the research behind each one. 👍/👎 on a carousel or a slide is stored with the features of what was voted (composition, personality, fonts, logo, layout, hook, energy). Each feature value keeps a Beta posterior; the art director reads what the owner clearly liked or disliked, and code picks replacements by **Thompson sampling**. A 👎 asks what's wrong: those words go to the critic before it approves the next slides, and each vote keeps what the critic said at the time, so **Your taste** shows how often the critic agrees with the owner and the share of carousels the owner liked per queue batch. A variety check keeps brands from looking alike: it sees the recent looks and swaps a font, device or logo position that the last runs repeated.

## The reel (off)

The server can also cut the approved layers into a 30 s reel with **HyperFrames**: a reel director picks scenes (photo wall, marquee, product drop, deck, grid, stack list), the cuts land on the music's beat, code fits the reading time (`fitBeats`) and a reel critic reviews the frames. A reel takes about as long as a whole carousel, so it is off; `REELS=1` in `server/.env` turns it back on (the button in Create, the reels in the Feed and the ZIP). The rules are in [docs/REEL_STANDARD.md](docs/REEL_STANDARD.md).

## Many websites, measured

The **Queue** runs a list of websites one after another, in named batches. Each run is measured in code: the set score, slides approved and approved on the first pass, rounds per slide, which critic checks and lint problems failed, cost and minutes. A batch's report (`server/runs/batches/<batch>.md`) says how the agents did; **Run again** puts the same websites in a new batch after a change, to compare. A saved list (`server/lists/<name>.txt`, one website per line, kept out of git) shows up in the Queue as **Start 1–10**, **Start 11–20**…: each block of ten is its own batch, and **Watch live** opens the run in progress. The failure history (`FAILURES.md`) keeps every kind of failure across batches with its rate per batch, real examples and what fixed it before, from [docs/LESSONS.md](docs/LESSONS.md).

## What is code and what is a model

| Decided by code | Decided by a model |
| --- | --- |
| Slide geometry (`src/lint.ts`): overlaps, margins, faces, product whole in its card | Brand fit, content, aesthetics (critic checklist) |
| The fix contract (`src/fixes.ts`): only actions the templates can take; a forgotten fix is applied anyway | Which fix a failed check needs (fixer) |
| Text contrast (WCAG 4.5:1) and decor strength | The visual system and the decor prompts (art director) |
| SAM 3.1 one-bit mask decoding (`src/sam_mask.ts`), written from Meta's wire format | What the subject of each photo is |
| Thompson sampling over the owner's votes (`src/taste.ts`) | Reading the taste summary into the next design |

## Stack

- `server/`: Node 24 + TypeScript. The agents call the Meta Model API (OpenAI-compatible Chat Completions with tool calling and image input): `muse-spark-1.3`, `muse-wonder-1.0` (falls back to Spark), `muse-image-1.0` and `sam-3.1`. It drives GIMP as an MCP client, renders with HyperFrames (`npx hyperframes`, needs ffmpeg), streams every step to the app with Server-Sent Events and keeps the feed and the votes in SQLite (`node:sqlite`).
- `app/`: Flutter web. **Create** shows the agents working live (plan, tool calls, reviews, slides as they're approved); **Feed** shows the results and takes the votes.
- GIMP 3.2 with [gimp-mcp](https://github.com/maorcc/gimp-mcp) (GPLv3), run headless (`gimp-console`) by the server. Not included in this repo.
- Music: the [Mixkit](https://mixkit.co/license/#musicFree) free stock catalog (`server/data/music.json`, built by `server/scripts/build-music-catalog.mjs`).

## Run it

You need Node 24, Flutter 3.38, ffmpeg, a Chromium browser (Edge or Chrome) and GIMP 3.2 with the gimp-mcp plugin and its Python server.

```bash
cd app && flutter build web && cd ..   # once, and after changing the app
cd server
cp .env.example .env                   # MODEL_API_KEY, gimp-mcp paths, GIMP_CONSOLE
npm install
npm run check-gimp                     # optional: draws a test slide in headless GIMP
npm start                              # open http://localhost:8787
```

To watch the agents work in the GIMP window instead, leave `GIMP_CONSOLE` empty, open GIMP and run **Tools › MCP › Start MCP Server**.

To develop the app with hot reload: `flutter run -d chrome --dart-define=API_URL=http://localhost:8787`.

## Tests

```bash
cd server && npm run typecheck && npm test
cd app && flutter analyze
```

The tests cover the code that decides, without calling the model API or GIMP: the geometry lint, the fix contract, the SAM mask decoder (against a reference encoder written from the same spec), reel timing, taste learning, run metrics and color contrast. CI runs them on every pull request.

## Docs

- [docs/SCOPE.md](docs/SCOPE.md): the agency flow, what is in and out of scope, and what "done" means for the demo.
- [docs/REEL_STANDARD.md](docs/REEL_STANDARD.md): the motion rules of the reel (off; `REELS=1`).
- [docs/LESSONS.md](docs/LESSONS.md): what fixed each kind of failure.
- [CONTRIBUTING.md](CONTRIBUTING.md): branches, atomic commits and pull requests.

## Built during the Meta Global AI Developer Hackathon 2026

Open source under the [MIT License](LICENSE). The Lumi name, logo and mascot are the brand of the product and are not covered by the license.

Made by Eduardo Romero at [Kodemex](https://kodemex.com.mx): web, apps and paid ads for businesses. Need something like this for your company? [kodemex.com.mx](https://kodemex.com.mx)
