# Releasing rewound

Releases publish to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers)
(GitHub Actions OIDC) with provenance. There are no npm tokens to leak, rotate, or
web-auth: the registry trusts `release.yml` in this repository, and every publish
requires a human approval on the protected `release` environment.

## Cutting a release

```bash
# 1. bump the version, commit to main
npm version 0.5.0 --no-git-tag-version && git commit -am "chore: v0.5.0"

# 2. tag and push
git tag -a v0.5.0 -m "rewound v0.5.0" && git push origin main v0.5.0
```

3. GitHub Actions runs the full test suite against the tag, checks the tag matches
   `package.json`, and then **pauses** for approval on the `release` environment.
4. Approve from github.com or the GitHub mobile app (repo → Actions → the waiting run
   → Review deployments → approve). npm publish happens with provenance attached.

## If a release run fails

Tags are immutable: never delete, move, or re-push a version tag — provenance and
anyone who fetched it depend on that. Fix the problem on `main`, bump to the **next
patch version**, and tag that. (v0.4.1 is a permanent example: its run failed on a
lockfile-sync error, the fix shipped as v0.4.2.)

## After npm publish: Homebrew

```bash
curl -sL https://registry.npmjs.org/rewound/-/rewound-0.5.0.tgz | shasum -a 256
# edit homebrew-tap/Formula/rewound.rb: bump url version, paste new sha256, push
```

## Verifying a release

Every publish has a provenance attestation linking the tarball to the exact commit and
workflow run: `npm audit signatures` on an installed copy, or the "Provenance" panel on
the npm package page.
