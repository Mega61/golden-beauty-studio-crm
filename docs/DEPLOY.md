# Deploying the CMS

**Merging to `master` deploys.** The stack `strapi-cms` runs in Portainer's Git
mode, from `deploy/compose/strapi-stack.yml` in this repo, and polls it every
5 minutes:

1. `.github/workflows/build-and-push.yml` builds the image and pushes it to GHCR
   (`:latest` and `:<commit-sha>`).
2. It writes the new image **digest** into `deploy/compose/.env`
   (`STRAPI_IMAGE=…@sha256:…`) and commits `[skip ci] deploy: cms <sha>`.
3. Portainer sees the new commit on its next poll, pulls that exact image and
   recreates the container. Nothing times out in a browser, and CI has no
   credential for the VM.

Secrets never go in the compose file: every `${VAR}` is set in Portainer →
stack `strapi-cms` → Environment variables. The compose and `.env` are public.

The first poll after a merge pulls the image on the VM, which takes a minute or
two (the `node_modules` layer is big). Strapi then needs ~1 min to boot.

## Why "Update the stack" in the Portainer UI fails with a 500

Clicking **Update the stack** with *Re-pull image* on holds a single HTTP request
open for the entire pull **and extraction**. This image's big layer is
`node_modules` — Strapi plus `sharp`/libvips — and unpacking it on a small VM
takes longer than the reverse proxy in front of Portainer will wait. The proxy
gives up, Portainer's Docker call is cancelled, and the browser gets a 500 while
`dockerd` is often still extracting happily in the background.

The tell in the Portainer log is a long run of `Extracting NN s` lines that simply
stop at ~30 s with no Docker error of its own. If the registry or credentials were
the problem you would never reach "Extracting" at all — the pull would fail at
authentication or manifest resolution. **Adding the registry to Portainer does not
help this failure**; the pull is already working.

## Deploying by hand (Git mode broken, or an urgent hotfix)

Pre-pull on the VM so nothing waits on a browser request, then update without
re-pulling:

```bash
# On the VM, over SSH:
docker pull ghcr.io/mega61/golden-beauty-studio-crm:latest
```

Then in Portainer: stack `strapi-cms` → **Pull and redeploy** with *Re-pull
image* **OFF**. In Git mode the image comes from `deploy/compose/.env`, so a
hand deploy of a different image only lasts until the next poll: commit the
digest there too.

## Before blaming the timeout: check disk

A full disk produces the same symptom — extraction crawls, then fails — and this
box also holds Postgres and the Media Library cache.

```bash
df -h /var/lib/docker          # >90% used is your answer
docker system df               # how much is reclaimable
docker image prune -af         # old CRM images add up fast, one per deploy
docker builder prune -af       # build cache, if you ever build on the VM
```

Each deploy leaves the previous image behind. Pruning after a successful deploy is
worth doing routinely.

## Rolling back

`git revert` the `[skip ci] deploy: cms <sha>` commit (through a PR, like any
change) and Portainer goes back to exactly the previous image on its next poll.
The digest in `deploy/compose/.env` is always what is live.

## Verifying a deploy landed

```bash
docker inspect --format '{{.Image}} {{.State.Health.Status}}' strapi
docker logs --tail 40 strapi     # look for "Strapi started successfully"
curl -fsS https://cms.goldenbeautystudio.com.co/_health && echo OK
```

On the first boot after a schema change, the bootstrap also logs the migration
work — for the careers feature, `[careers] created Media Library folder` and
`[careers] seeded N cargos`.
