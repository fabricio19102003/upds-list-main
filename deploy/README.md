# Deploy the private classroom gateway

The public browser calls only this portal. The portal backend reads one Docker-mounted token and calls the private Cupos API on `cupos-turmas_backend` for the pinned period `2026-2`.

## Fixed runtime configuration

Do not rename or repurpose these variables:

| Name | Fixed meaning |
|---|---|
| `CUPOS_STUDENT_CLASSROOM_BASE_URL` | Safe private URL: `http://cupos-turmas-student-classrooms-v1:3000/api/integrations/student-classrooms/v1` |
| `CUPOS_STUDENT_CLASSROOM_TOKEN_FILE` | Safe mounted path: `/run/secrets/cupos_student_lookup_token`; the token itself never belongs in the environment |
| `STUDENT_LOOKUP_PERIOD` | Pinned period `2026-2` |

## Prerequisites

1. Confirm the Cupos stack owns the external network without printing its configuration: `docker network inspect cupos-turmas_backend >/dev/null`.
2. Create the owner-only secret directory: `sudo install -d -m 0700 -o DEPLOY_USER -g DEPLOY_GROUP /srv/secrets/portal`.
3. Enter the single 64-hex token with `sudoedit /srv/secrets/portal/cupos-student-lookup-token`; never place it in an environment file or command argument.
4. Set the runtime owner and mode without reading the value: `sudo chown DEPLOY_USER:DEPLOY_GROUP /srv/secrets/portal/cupos-student-lookup-token && sudo chmod 0600 /srv/secrets/portal/cupos-student-lookup-token`.
5. Preserve `/srv/apps/aulas-upds/data/*.txt` for this release. The new server and image never read it; the read-only mount and deploy preflight exist only so the previous TXT-based image can be restored.

## Deploy

From a clean checkout at the reviewed `origin/main`, run `bash deploy/release-production.sh` and type the full SHA when prompted. The local wrapper creates a detached clean worktree, runs package, image, Trivy, transfer, Nginx, rollout, and safe public/remote health gates; `deploy.sh` remains the only remote rollout authority.

Use `bash deploy/release-production.sh --dry-run` to run local certification and `rsync --dry-run`. Rsync still opens SSH and starts remote rsync, but it performs no file mutation and the wrapper runs no deploy command. Defaults can be overridden with `RELEASE_HOST`, `RELEASE_USER`, `RELEASE_IDENTITY`, `RELEASE_REMOTE_DIR`, `RELEASE_BRANCH`, and `RELEASE_DOMAIN`.

If the active Nginx hash differs, the wrapper stops before rollout and prints the exact human-run `sudo install`, `nginx -t`, and reload commands. Run those only after review, then rerun the wrapper; it never executes `sudo`.

The deploy succeeds only after remote `/health` and metadata readiness, then public safe metadata and an intentionally invalid name request returning sanitized `400`. The invalid request is rejected before private lookup and contains no student data. Probe bodies are validated without printing them.

## Token rotation

The private API accepts one token, so coordinate a short cutover: prepare the same replacement token on both services, activate it upstream, replace the portal secret with `sudoedit`, restore owner-only mode, and rerun the certified release to recreate the container. Never inspect or compare token values in terminal output.

## Rollback and cleanup

`deploy.sh` restores the previous image when health or metadata readiness fails. That image remains compatible because the TXT preflight and read-only mount are retained for this one release. For manual rollback, retag the previous image, run Compose with `--no-build`, verify `/health`, and restore the previous Nginx site so `/api/search` is rate-limited again.

After the gateway release is stable and no TXT-image rollback is required, remove the Compose data mount, deploy TXT preflight, host runtime TXT directory, and tracked source TXT files in a separate reviewed cleanup.
