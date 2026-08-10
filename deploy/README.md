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

1. Transfer code without deleting host state: `rsync -az --exclude '.git/' --exclude '.env*' --exclude 'node_modules/' --exclude 'dist/' --exclude 'src/data/' --exclude 'data/' ./ USER@HOST:/srv/apps/aulas-upds/`.
2. Run `RELEASE_TAG=<certified-full-sha> bash /srv/apps/aulas-upds/deploy/deploy.sh`. The lowercase 40-character SHA must identify the exact reviewed commit.
3. Install the existing rate-limit zone, then the HTTPS site: `sudo install -m 0644 deploy/nginx/aulas-upds-rate-limit.conf /etc/nginx/conf.d/aulas-upds-rate-limit.conf && sudo install -m 0644 deploy/nginx/aulas-upds.conf /etc/nginx/sites-available/aulas-upds.conf`.
4. Validate before reload: `sudo nginx -t && sudo systemctl reload nginx`.

The deploy succeeds only after `/health` and safe portal metadata both pass. Metadata must report API v1, period `2026-2`, a 64-hex `dataVersion`, and unavailable schedules. Neither probe prints its response body.

## Token rotation

The private API accepts one token, so coordinate a short cutover: prepare the same replacement token on both services, activate it upstream, replace the portal secret with `sudoedit`, restore owner-only mode, and rerun the certified release to recreate the container. Never inspect or compare token values in terminal output.

## Rollback and cleanup

`deploy.sh` restores the previous image when health or metadata readiness fails. That image remains compatible because the TXT preflight and read-only mount are retained for this one release. For manual rollback, retag the previous image, run Compose with `--no-build`, verify `/health`, and restore the previous Nginx site so `/api/search` is rate-limited again.

After the gateway release is stable and no TXT-image rollback is required, remove the Compose data mount, deploy TXT preflight, host runtime TXT directory, and tracked source TXT files in a separate reviewed cleanup.
