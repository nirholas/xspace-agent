# Spec 7 — Deploy pipeline (GitHub Actions → GCP VM)

`nirholas/xspace-agent` currently deploys by SSH'ing into the VM and `rsync`ing files, then manually `systemctl restart`ing services. Build a proper CI/CD pipeline.

## Goals

- Every PR runs lint + tests (covered by spec #6 — this spec depends on that one being merged).
- Every merge to `main` automatically:
  1. Runs tests one more time
  2. Builds a deployable bundle (excludes node_modules, dev deps, .git)
  3. Rsyncs to the GCP VM via Identity-Aware Proxy (no inbound SSH ports needed)
  4. Runs migrations / health checks
  5. Reloads systemd units, watches the new server come up
  6. Rolls back automatically if health checks fail within 60 seconds
- Manual `Deploy` button (workflow_dispatch) for ad-hoc deploys from any branch.
- Blue/green or canary path documented.

## What's there now

No CI/CD. Manual deploy procedure lives in `BUILD_LOG.md`.

## GitHub Actions workflow

`.github/workflows/deploy.yml`:

```yaml
name: deploy

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      branch:
        description: Branch to deploy (default: main)
        required: false
        default: main

concurrency:
  group: deploy
  cancel-in-progress: false  # never overlap deploys

permissions:
  contents: read
  id-token: write     # for Workload Identity Federation to GCP

jobs:
  test:
    uses: ./.github/workflows/ci.yml

  deploy:
    needs: test
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${{ inputs.branch || 'main' }} }

      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }

      - name: Install production deps
        run: npm ci --omit=dev --no-audit --no-fund

      - name: Build deployable bundle
        run: |
          mkdir -p deploy-bundle
          rsync -a \
            --exclude='.git' \
            --exclude='node_modules' \
            --exclude='dist*' \
            --exclude='.pnpm-store' \
            --exclude='.turbo' \
            --exclude='.env*' \
            --exclude='*.cookies.json' \
            --exclude='*.log' \
            --exclude='debug-screenshots' \
            --exclude='character-studio' \
            --exclude='packages' \
            --exclude='examples' \
            --exclude='tests' \
            --exclude='.github' \
            ./ deploy-bundle/
          # ship production node_modules to skip npm install on VM (faster, deterministic)
          cp -r node_modules deploy-bundle/node_modules

      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
          service_account: ${{ secrets.GCP_DEPLOY_SA }}

      - name: Set up gcloud
        uses: google-github-actions/setup-gcloud@v2

      - name: Rsync bundle to VM via IAP
        run: |
          gcloud compute scp --recurse --tunnel-through-iap \
            --zone=us-central1-a \
            deploy-bundle/* \
            agent@swarm-agent:/home/agent/x-spaces-staging/

      - name: Atomic switchover with rollback
        run: |
          gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
            set -e
            # Snapshot current for rollback
            sudo rm -rf /home/agent/x-spaces-previous
            sudo cp -r /home/agent/x-spaces-v2 /home/agent/x-spaces-previous
            # Move staging into place
            sudo rsync -a --delete /home/agent/x-spaces-staging/ /home/agent/x-spaces-v2/
            sudo chown -R agent:agent /home/agent/x-spaces-v2
            # Reload
            sudo systemctl restart swarm-server.service
            # Health check (60s budget)
            for i in \$(seq 1 30); do
              if curl -sf -o /dev/null \
                -H \"Authorization: Bearer \$(sudo cat /home/agent/x-spaces-v2/.admin-key)\" \
                http://localhost:3000/health; then
                echo \"Health check passed (attempt \$i)\"
                exit 0
              fi
              sleep 2
            done
            echo \"Health check failed — rolling back\"
            sudo rsync -a --delete /home/agent/x-spaces-previous/ /home/agent/x-spaces-v2/
            sudo systemctl restart swarm-server.service
            exit 1
          "

      - name: Notify deploy
        if: always()
        run: |
          status=${{ job.status }}
          curl -s -X POST "$DEPLOY_WEBHOOK_URL" -H "Content-Type: application/json" \
            -d "{\"text\":\"x-spaces deploy $status — sha ${{ github.sha }}\"}"
        env:
          DEPLOY_WEBHOOK_URL: ${{ secrets.DEPLOY_WEBHOOK_URL }}
```

## Secrets / GitHub repo configuration

Add these secrets to `nirholas/xspace-agent`:

| Secret | What |
|---|---|
| `GCP_WIF_PROVIDER` | Workload Identity Provider resource name, e.g. `projects/93741856042/locations/global/workloadIdentityPools/github/providers/xspace-agent` |
| `GCP_DEPLOY_SA` | Service account email, e.g. `xspace-deployer@aerial-vehicle-466722-p5.iam.gserviceaccount.com` |
| `DEPLOY_WEBHOOK_URL` | Slack / Discord webhook for deploy notifications (optional) |

## GCP-side setup (run once, documented in `vm/setup-deploy.md`)

```bash
# Create deploy service account
gcloud iam service-accounts create xspace-deployer \
  --display-name="x-spaces GitHub Actions deployer"

# Grant minimum perms
gcloud projects add-iam-policy-binding aerial-vehicle-466722-p5 \
  --member="serviceAccount:xspace-deployer@aerial-vehicle-466722-p5.iam.gserviceaccount.com" \
  --role="roles/compute.osLogin"
gcloud projects add-iam-policy-binding aerial-vehicle-466722-p5 \
  --member="serviceAccount:xspace-deployer@aerial-vehicle-466722-p5.iam.gserviceaccount.com" \
  --role="roles/iap.tunnelResourceAccessor"

# Workload Identity Federation for GitHub
gcloud iam workload-identity-pools create github \
  --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc xspace-agent \
  --location=global --workload-identity-pool=github \
  --display-name="nirholas/xspace-agent" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository == 'nirholas/xspace-agent'" \
  --issuer-uri="https://token.actions.githubusercontent.com"

# Allow that provider to impersonate the deployer SA
gcloud iam service-accounts add-iam-policy-binding \
  xspace-deployer@aerial-vehicle-466722-p5.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/93741856042/locations/global/workloadIdentityPools/github/attribute.repository/nirholas/xspace-agent"
```

Document these in `vm/setup-deploy.md` with copy-paste blocks.

## Rollback story

The deploy step keeps a snapshot at `/home/agent/x-spaces-previous`. On health-check failure it rsyncs that back. For manual rollback (e.g. caught a bug 10 minutes after deploy):

```bash
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  sudo rsync -a --delete /home/agent/x-spaces-previous/ /home/agent/x-spaces-v2/
  sudo systemctl restart swarm-server.service
"
```

Wrap that in a `gh workflow run rollback.yml` button via a second workflow file.

## Blue/green (stretch)

For zero-downtime deploys:
- Run two systemd units: `swarm-server-blue.service` on port 3000, `swarm-server-green.service` on port 3001.
- A small nginx in front decides which is "active".
- Deploy installs into the inactive color, runs health checks, then `nginx -s reload` to swap.
- This needs nginx config + a tiny health-aware shim, so it's a separate follow-up. Document the path in `docs/blue-green.md`.

## Test plan

1. Push a trivial change (docstring update) to a feature branch, open PR. Confirm CI passes.
2. Merge to main. Watch the `deploy` workflow.
3. Confirm `/health` returns 200 within 60 s of deploy step.
4. Push a deliberately broken change (e.g. crash on startup). Confirm rollback fires automatically.
5. Trigger `workflow_dispatch` from a feature branch. Confirm it deploys that branch.
6. Tail `/var/log/swarm-server.log` during a deploy — confirm the restart is clean.

## Don'ts

- Don't put SSH private keys in repo secrets. Use Workload Identity Federation only.
- Don't bypass `requireAuth` for the health check — use the admin key from the VM's local file.
- Don't deploy without running tests first (don't disable the `needs: test` gate).
- Don't ship `node_modules` if it doubles deploy time — use `npm ci --omit=dev` on the VM after rsync as an alternative.

## When done

PR `feat(spec-7): GitHub Actions deploy with rollback`. PR description includes: a screenshot of a successful end-to-end deploy run, a screenshot of a forced rollback after an artificial failure, and the resulting GCP `gcloud compute ssh` log showing the snapshot/swap sequence.
