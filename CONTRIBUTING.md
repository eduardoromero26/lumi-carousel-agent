# Contributing

## History so far

The project was built in nine days for the Meta Global AI Developer Hackathon 2026 (Oct 26 to
Nov 4), by one person running several coding sessions on the same folder. Git starts on Nov 1 with a
snapshot of the work since Oct 28 (`chore: snapshot before references and critic calibration`). Until the submission,
commits landed straight on `main`, and some group a whole area, because the same files changed for
several reasons at once. The history is left as it happened: it is not rewritten to look tidier.
From the submission on, every change follows the rules below.

## Branches and pull requests

- `main` is always green: every change lands through a pull request and CI.
- One branch per change, named by kind: `feat/…`, `fix/…`, `test/…`, `docs/…`, `chore/…`.
- Pull requests are merged with a merge commit, so each commit inside them stays in the history.

`scripts/pr.sh` does the round trip from a branch with commits: it pushes, opens the pull request,
waits for CI and merges.

```bash
git switch -c fix/cover-crop
# … atomic commits …
scripts/pr.sh "fix(templates): keep the subject whole on the cover"
```

## Commits

Atomic and in [Conventional Commits](https://www.conventionalcommits.org/): one logical change per
commit, and the code builds at every commit.

```
feat(critic): reject a slide whose product is cut by its own photo
fix(site): ask Wix for the original image, not the thumbnail
test(lint): cover text over faces
```

Scopes are the module or the agent: `server`, `app`, `gimp`, `site`, `sam`, `analyst`, `director`,
`art-director`, `designer`, `critic`, `fixer`, `templates`, `lint`, `reel`, `motion`, `music`, `feed`, `queue`, `metrics`.

## Checks

```bash
cd server && npm run typecheck && npm test
cd app && flutter analyze
```

The tests never call the model API or GIMP: they cover the code that decides (geometry lint, fixer
contract, SAM mask decoding, reel timing, taste learning, color contrast).
