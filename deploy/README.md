# Deploy the public student search

The container serves only minimized search results. Nominal data stays in a read-only host mount and never enters the image or code transfer.

## First deployment

1. Create `/srv/apps/aulas-upds/data` on Ubuntu 24.04 with owner-only write access.
2. Transfer code without deleting host state:
   `rsync -az --exclude '.git/' --exclude '.env*' --exclude 'node_modules/' --exclude 'dist/' --exclude 'src/data/' --exclude 'data/' ./ USER@HOST:/srv/apps/aulas-upds/`
3. Transfer the protected source files separately to `/srv/apps/aulas-upds/data/`; do not use `--delete`.
4. On the VPS run `RELEASE_TAG=<certified-full-sha> bash /srv/apps/aulas-upds/deploy/deploy.sh`. The 40-character lowercase SHA must match the exact GitHub commit approved by the certification process.
5. Install and activate the HTTP bootstrap:
   `sudo install -m 0644 deploy/nginx/aulas-upds.bootstrap.conf /etc/nginx/sites-available/aulas-upds.conf`
   `sudo ln -sfn /etc/nginx/sites-available/aulas-upds.conf /etc/nginx/sites-enabled/aulas-upds.conf`
   `sudo nginx -t && sudo systemctl reload nginx`
6. Issue the certificate:
   `sudo certbot certonly --webroot -w /var/www/letsencrypt -d aulas.upds-cobija.cloud`
7. Install the rate-limit zone in the Nginx `http` context before installing or testing the HTTPS site:
   `sudo install -m 0644 deploy/nginx/aulas-upds-rate-limit.conf /etc/nginx/conf.d/aulas-upds-rate-limit.conf`
   `sudo install -m 0644 deploy/nginx/aulas-upds.conf /etc/nginx/sites-available/aulas-upds.conf`
   `sudo nginx -t && sudo systemctl reload nginx`

## Verify

Run `curl --fail http://127.0.0.1:3020/health`, inspect Compose for the `127.0.0.1` binding and read-only mount, then verify HTTP redirect, HTTPS headers, valid search, rejected oversized/cross-origin requests, and `sudo certbot renew --dry-run`.

## Rollback

`deploy.sh` restores the previous image automatically when rollout or health fails. For manual rollback, retag a known previous `aulas-upds` image, run Compose with `--no-build`, and verify `/health`. Data is unchanged by deployment. Preserve the previous Nginx site, restore it, run `sudo nginx -t`, and reload only after validation.
