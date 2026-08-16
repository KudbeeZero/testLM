# Kudbee — Heroku → AWS Migration Matrix

> **Phase 1A deliverable.** This matrix maps every functional Heroku component to
> its AWS-native replacement. **Nothing is deleted until the replacement is
> identified, configured, and locally verified** (verify-before-delete rule).
>
> AWS is the authoritative infrastructure. Heroku is retired.

## Deployment / process formation

| Heroku component | Current purpose | AWS replacement | Replacement status | Safe to remove? |
| --- | --- | --- | --- | --- |
| `Procfile` | Dyno process formation (web, hermes-worker, monitor-worker, sentinel, release) | EC2 (2× t3.micro) + systemd/PM2 process manager | EC2 running; `scripts/deploy-ec2.sh` + `deploy-ec2-ssm.sh` exist (0 Heroku refs) | ✅ after EC2 deploy verified |
| `heroku-pipelines.json` | Dev/staging/prod pipelines, eco dynos | GitHub Actions workflows (`.github/workflows/*.yml`) | Workflows present | ✅ |
| `app.json` | Heroku app manifest | GitHub Actions + EC2 deploy | Workflows present | ✅ |
| `scripts/deploy-dev.sh` | Heroku CLI dev deploy | `scripts/deploy-ec2.sh` / `deploy-ec2-ssm.sh` | Present, 0 Heroku refs | ✅ |
| `scripts/deploy-prod.sh` | Heroku CLI prod deploy | `deploy-ec2.sh` / `deploy-ec2-ssm.sh` | Present | ✅ |
| `scripts/deploy-staging.sh` | Heroku CLI staging deploy | `deploy-ec2.sh` / `deploy-ec2-ssm.sh` | Present | ✅ |
| `scripts/canary-deploy.mjs` | Canary deploy to Heroku git remote | EC2 canary + GitHub Actions | Replace with EC2 path | ✅ |
| `scripts/dyno-manager.mjs` | Heroku dyno management | EC2 systemd/PM2 supervision | Design in progress | ✅ (after EC2) |
| `scripts/edisbox-deploy.mjs` | Edisbox deploy to Heroku | EC2/SSM deploy | Replace | ✅ |
| `scripts/edisbox-pipeline.mjs` | Edisbox pipeline (Heroku) | GitHub Actions pipeline | Replace | ✅ |
| `scripts/deploy-log.mjs` | Deploy logging (Heroku release) | Log to CloudWatch/S3 | Replace log sink | ✅ |

## Services / data

| Heroku component | Current purpose | AWS replacement | Replacement status | Safe to remove? |
| --- | --- | --- | --- | --- |
| Heroku Postgres | DB | Neon `local-comp` + AWS RDS (existing) | Neon + RDS configured | ✅ |
| Heroku Redis | Cache/queue | Upstash Redis (Fast/Slow brain) | Configured | ✅ |
| Heroku scheduler | Scheduled jobs | QStash / AWS EventBridge | QStash configured | ✅ |
| Heroku logs | Logs | CloudWatch / S3 | CloudWatch + S3 security buckets | ✅ |
| Heroku config vars | Env config | `.env` local + AWS Secrets Manager / Parameter Store | `.env` gitignored | ✅ |

## Env vars / URLs in code

| Reference | Location | Action |
| --- | --- | --- |
| `HEROKU_SLUG_COMMIT`, `HEROKU_RELEASE_VERSION` | `services/ingestion/server.js` | Replace with `SOURCE_VERSION` / git SHA |
| `HEROKU_API_KEY` | `services/lib/recoveryEngine.ts` | Remove Heroku dyno-restart/redeploy; use EC2/systemd recovery |
| `HEROKU_APP_NAME` | `services/sentinel/src/poller.ts` | Replace egress URL with EC2 public URL |
| `.herokuapp.com` URLs (CORS, sentinel, einstein, bootstrap, browser-verifier, canary, box-web-verify) | multiple | Replace with EC2/domain URLs |
| `api.heroku.com`, `git.heroku.com` | `recoveryEngine.ts`, `agent-bootstrap.mjs`, `canary-deploy.mjs` | Remove |

## Comments / informational references

| Reference | Location | Action |
| --- | --- | --- |
| `outputRedactor.ts` comment | services/lib | Update comment (no code impact) |
| `temporalTechnician.ts` metadata/examples | services/lib | Update examples |
| `OSControlBar.tsx` deploy-status UI | apps/web | Update label to AWS/EC2 |
| `LearningCenter.tsx` sample data | apps/web | Update sample |
| `MiddlewareInspector.tsx` comment | apps/web | Update comment |
| `sentinel/src/index.ts` comment | services/sentinel | Update comment |
| `subSwarm.ts` dyno-watcher task | services/agents | Update to EC2 watcher |

## Verification gates (Phase 1E)
- [ ] `grep -ri heroku` in functional code → **0**
- [ ] Fuel Gauge ingestion server boots
- [ ] AWS/EC2 deploy path works
- [ ] No user work lost
- [ ] Checkpoint exists (`11268a3` parent; new checkpoint in Fuel Gauge)
