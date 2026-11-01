# Contributing

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
