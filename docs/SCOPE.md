# Scope until the deadline

Deadline: 2026-11-04, 9:00 PM ET. Target: **best agentic use case**.

The product is an agency's production flow for a small business, run by agents. A business that
can't pay an agency gives its website, and nothing else: the run is automatic. The agents work the
way the agency does: they read the brand, plan with the real material there is, design in a real
editor, check their own work, take the client's revisions and deliver.

## The flow

| Step | Who | What the agency does |
| --- | --- | --- |
| 1. Intake | Analyst | Reads the website as a visitor sees it and sorts what it finds: logo, products, photos, banners. |
| 2. Strategy | Director | Picks the format for the business (catalog, proof, benefits…) and plans the slides from real facts only. |
| 3. Art direction | Art director | Sets one visual system from the brand's own website, plus its decor kit. |
| 4. Production | Templates + SAM | Builds each slide in GIMP with real layers, the subject whole and uncovered. |
| 5. QA | Lint, critic, fixer | Code measures the geometry, the critic answers a checklist, the fixer changes the template and the best round is kept. Then the whole set is reviewed. |
| 6. Client revision | Owner → fixer | The owner asks for changes in plain words; the critic checks they were made. |
| 7. Delivery | System | The carousel (PNG and editable XCF) and the caption, in one ZIP. |

## In scope

- One deliverable: an Instagram/Facebook carousel (4:5) with its caption.
- Input: a website URL and the language. Nothing is asked of the owner during the run.
- The seven steps above, visible in the app while they happen.
- Three showcase brands, each with a different case: a catalog with products, a business with few
  photos, and a service with people.
- A local server. A tunnel only if the judges need to try it.
- As many runs on as many websites as the credits allow: that is where the quality comes from.

## Out of scope

These wait until after the hackathon:
- Publishing to Facebook or Instagram (no Meta App, OAuth or Graph API). The owner downloads the
  carousel and publishes it.
- The 30 s reel after every carousel. A reel takes as long as a whole carousel, so it is made only
  when the owner asks for it from the ready window (`REELS=1` in `server/.env` makes one every time).
- Other formats: stories, ads, single posts.
- Editing the owner's video clips.
- Reading pages beyond the URL given.
- Icons, new decor and new uses of Muse Image.
- Hosting, accounts, sign-in, several runs at once.
- Anything from Lumi, code or prompts.

## Done for the demo

- Every showcase brand, three runs in a row:
  - the set review scores 8/10 or more;
  - every slide is approved by the critic (none "kept") in two rounds or fewer.
- Across the runs, each agentic moment shows at least once:
  - a slide rejected and fixed;
  - an owner's revision.
- No run gets stuck. A slide the agents can't fix ends as "kept", with the reason in view.
- The repo is public, and the README says how to run it.
- The 3-minute video shows only what was built during the event.

## The rule for new work

Until the deadline, only three kinds of work go in:
- bug fixes;
- the quality of the three showcase brands;
- making the agency flow visible.

Everything else goes to the out-of-scope list.
