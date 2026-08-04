# Deploying the CMS

The image is built by GitHub Actions on every push to `master`
(`.github/workflows/build-and-push.yml`) and pushed to GHCR as two tags:

- `ghcr.io/mega61/golden-beauty-studio-crm:latest`
- `ghcr.io/mega61/golden-beauty-studio-crm:<commit-sha>` ← use this to roll back

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

## Pick one of these three

### 1. Webhook (recommended, and automatic)

Portainer redeploys server-side, so nothing can time out in a browser.

1. Portainer → the stack → **Webhooks** → create one, copy the URL.
2. GitHub → repo → Settings → Secrets and variables → Actions → new secret
   `PORTAINER_WEBHOOK_URL` with that URL. Treat it as a password: anyone holding
   it can trigger a redeploy.
3. Push to `master`. CI builds, pushes, then calls the webhook. Watch progress in
   the Portainer stack log, not in the Actions run — a 2xx from the webhook means
   "accepted", not "finished".

Until the secret exists the workflow's redeploy step prints a note and passes, so
adding it is optional.

### 2. Pre-pull, then update without re-pulling

Good when you want to deploy by hand, and the fastest way out when the UI is
already stuck.

```bash
# On the VM, over SSH:
docker pull ghcr.io/mega61/golden-beauty-studio-crm:latest   # takes as long as it takes
```

Then in Portainer: **Update the stack** with *Re-pull image* **OFF**. The image is
already local, so the request finishes in seconds and never approaches the
timeout.

### 3. Raise the proxy timeout

Only needed if you insist on pulling from the UI. On whatever fronts Portainer
(Nginx Proxy Manager, Caddy, Traefik), raise the read/response timeout for that
host to 300s. For Nginx:

```nginx
proxy_read_timeout 300s;
proxy_send_timeout 300s;
```

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

```bash
# In the stack's compose, pin the tag to the last good commit:
image: ghcr.io/mega61/golden-beauty-studio-crm:<commit-sha>
```

Deploying a SHA tag instead of `:latest` is also the honest way to know what is
running — `:latest` tells you nothing about which commit is live.

## Verifying a deploy landed

```bash
docker inspect --format '{{.Image}} {{.State.Health.Status}}' strapi
docker logs --tail 40 strapi     # look for "Strapi started successfully"
curl -fsS https://cms.goldenbeautystudio.com.co/_health && echo OK
```

On the first boot after a schema change, the bootstrap also logs the migration
work — for the careers feature, `[careers] created Media Library folder` and
`[careers] seeded N cargos`.
