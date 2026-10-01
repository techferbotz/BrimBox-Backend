# Deploying BrimBox

BrimBox runs on the shared House of Apps EC2 box (protocols 03 + 05). The standard deploy is protocol 05.
This page covers BrimBox's setup on the box and its project-specific steps.

| | |
|---|---|
| Domain | `brimbox.ferbotz.com` (DNS on Cloudflare, **DNS only** / grey cloud, like the other apps) |
| Box | shared EC2 `i-0ee7ba0922056100d`, **t3.small**, `ap-south-1a`, Elastic IP `13.205.128.80` |
| Checkout | `/opt/apps/brimbox/BrimBox-Backend` |
| Compose project | `brimbox` (`docker-compose.prod.yml`), container `brimbox-app-1` |
| Loopback port | `127.0.0.1:8094` → container `8080` |
| nginx site | `/etc/nginx/sites-available/brimbox` (symlinked into `sites-enabled/`) |
| Repo | `github.com/techferbotz/BrimBox-Backend` (private), branch `master`; the box pulls over SSH with its own `techferbotz` key |

## Status

- **2026-10-01 — P0 live at `https://brimbox.ferbotz.com`** (commit `3cb36e1`): `/`, `/config` and the
  legal pages. Plain HTTP redirects to HTTPS. The Let's Encrypt certificate expires 2026-12-30 and renews
  automatically (`certbot.timer`; a renewal dry run passed).
- **2026-10-01 — P1 deployed** (commit `06555bd`).
  - **Database:** `brimbox` (owned by role `brimbox`) on the host PostgreSQL 18.6, with migration
    `20261001094719_init_accounts` applied.
  - **Endpoints:** `/api/v1/auth/*` and `/api/v1/me` are live.
  - **Sign-in:** answers 503 until `GOOGLE_CLIENT_ID` is set (Google OAuth client, below).

## Who does what

Following protocol 02, Claude runs deploys and migrations over SSH. A human runs anything that widens
access or touches an account. Claude prepares the exact steps for each.

| Step | Who | Status |
|---|---|---|
| Create the private GitHub repo and push | human creates, Claude pushes | done |
| Resize the box to t3.small (stop/start) | human (the auto-mode classifier blocks agents from stopping instances) | done 2026-10-01 |
| Clone on the box, write `.env`, build and start, nginx site | Claude, over SSH | done 2026-10-01 |
| DNS A record `brimbox` → `13.205.128.80`, DNS only (Cloudflare dashboard) | human | done 2026-10-01 |
| certbot for `brimbox.ferbotz.com` | Claude, over SSH | done 2026-10-01 |
| Details doc (protocol 00): `G:\My Drive\BrimBox\BrimBox details.md` | Claude | done 2026-10-01 |
| Postgres role + database, `pg_hba.conf` line, secrets in `.env`, migrate, app (P1) | Claude, over SSH | done 2026-10-01 |
| DB password + `JWT_SECRET` in the details doc (copied box → doc, never displayed) | Claude | done 2026-10-01 |
| Copy the details doc's "Secret values" into the HOA Credentials Registry | human | pending |
| Google OAuth client: consent screen, Android + Web clients | human | pending |
| R2 bucket + scoped API token (Cloudflare dashboard) — needed by P3 | human | pending |

## The box

- **Size:** resized from t3.micro to **t3.small** (2 vCPUs, 2 GB) on 2026-10-01, when BrimBox became the
  fifth app.
  - Before: 309 MB available and 601 MB in swap.
  - After: about 1.2 GB available and no swap.
- **Elastic IP:** `13.205.128.80` is an Elastic IP, so a stop/start keeps the address and no DNS changes.
- **Boot:** every container uses `restart: unless-stopped`, and docker, postgresql and nginx are all
  enabled at boot.
- **Disk is critical:** the 19 GB root was 86% full before BrimBox, and **97% (747 MB free) after the
  P1 build** (2026-10-01). Docker holds about 11.9 GB of images, of which about 6.75 GB is unused by any
  container (some may be other apps' rollback images), plus 5.3 GB of build cache (1.27 GB
  reclaimable). Check `df -h /` and `docker system df` before every build. Pruning affects every app on
  the box, so ask first. Growing the EBS volume is the durable fix.

## First-time setup (P0, as run on 2026-10-01)

```bash
mkdir -p /opt/apps/brimbox && cd /opt/apps/brimbox      # /opt/apps is owned by ubuntu
git clone git@github.com:techferbotz/BrimBox-Backend.git
cd BrimBox-Backend

# Server .env — never committed; owner-only. P0 needs only these:
( umask 077; cat > .env <<'EOF'
PORT=8080
APP_PUBLIC_URL=https://brimbox.ferbotz.com
APP_HOST_PORT=8094
EOF
)

docker compose -f docker-compose.prod.yml up -d --build app
curl -s http://127.0.0.1:8094/        # expect: BrimBox Backend Running
```

The nginx site is `/etc/nginx/sites-available/brimbox`, in the same style as the other apps' sites.
certbot adds the 443 block and the HTTP→HTTPS redirect itself.

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name brimbox.ferbotz.com;

    # File bytes go straight to R2 with presigned URLs and never pass through the API,
    # so request bodies stay small JSON.
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8094;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/brimbox /etc/nginx/sites-enabled/brimbox
sudo nginx -t && sudo systemctl reload nginx   # never reload on a failed test: it would affect every app
```

Requests sent in the first moments after a reload can still reach the old workers and get nginx's 404.
Re-test after a second before concluding anything is wrong.

## TLS (done 2026-10-01)

The name must resolve to the box before certbot can prove ownership. certbot uses the box's existing
Let's Encrypt account, rewrites `sites-available/brimbox` with the 443 block and the HTTP→HTTPS
redirect, and tests nginx before reloading it.

```bash
nslookup brimbox.ferbotz.com 1.1.1.1                                       # expect 13.205.128.80
sudo certbot --nginx -d brimbox.ferbotz.com --non-interactive --redirect   # on the box
sudo certbot renew --dry-run --cert-name brimbox.ferbotz.com               # renewal check, changes nothing

# verify
curl -s https://brimbox.ferbotz.com/
curl -s https://brimbox.ferbotz.com/config
curl -sI https://brimbox.ferbotz.com/privacy | head -1
```

The three legal URLs are recorded in `BrimBox details.md` (protocols 00/12). They are what goes into the
Play Console.

To test a server block before its DNS exists, pin the name to the IP:
`curl --resolve brimbox.ferbotz.com:80:13.205.128.80 http://brimbox.ferbotz.com/`.

## P1 deploy: database and sign-in (runbook, done 2026-10-01)

Deploying doesn't need the Google OAuth client: until `GOOGLE_CLIENT_ID` is set, sign-in answers 503
and everything else works. From P1 on, every deploy with a schema change follows protocol 05's order:
migrate first, then rebuild the app.

> **Gotcha (bit us on the first P1 deploy).** If you drive these steps from a script piped into
> `ssh … 'bash -s'`, give every docker command `</dev/null` (or use `run -T`). Otherwise
> `docker compose run` reads the REST OF THE SCRIPT as its stdin, and every step after it silently
> never runs. That time, the migration had applied but the app was never rebuilt.

```bash
cd /opt/apps/brimbox/BrimBox-Backend && git pull

# 1. Can BrimBox's docker network reach the host Postgres? Compare its subnet with pg_hba.conf.
docker network inspect brimbox_default -f '{{(index .IPAM.Config 0).Subnet}}'
sudo grep -vE '^\s*(#|$)' /etc/postgresql/*/main/pg_hba.conf

# 2. Role + database. The password is generated here, goes straight into .env, and is never printed.
PW=$(openssl rand -hex 24)
sudo -u postgres psql -v ON_ERROR_STOP=1 -v pw="$PW" <<'SQL'
CREATE ROLE brimbox LOGIN PASSWORD :'pw';
CREATE DATABASE brimbox OWNER brimbox;
REVOKE CONNECT ON DATABASE brimbox FROM PUBLIC;
SQL
( umask 077; {
  echo "DATABASE_URL=postgresql://brimbox:${PW}@host.docker.internal:5432/brimbox?schema=public"
  echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
  echo "JWT_EXPIRES_IN=1h"
} >> .env ); unset PW

# 3. Migrate FIRST (always --build), then rebuild the app.
docker compose -f docker-compose.prod.yml run --rm --build migrate
docker compose -f docker-compose.prod.yml up -d --build app

# 4. Verify
curl -s https://brimbox.ferbotz.com/api/v1/me          # 401 UNAUTHORIZED
curl -s -X POST -H 'Content-Type: application/json' -d '{"idToken":"x"}' \
  https://brimbox.ferbotz.com/api/v1/auth/google        # 503 until GOOGLE_CLIENT_ID is set
curl -s https://brimbox.ferbotz.com/config              # still 200
```

Record the two new secrets, the database password and `JWT_SECRET`, in `BrimBox details.md` and the HOA
credentials registry. Copy them from the server `.env`; never paste them into chat.

### Google OAuth client (human, for sign-in)

Use a Google Cloud project of BrimBox's own, so the sign-in consent screen says "BrimBox":

1. **OAuth consent screen:** app name **BrimBox**, a support email, and the privacy and terms URLs
   (`https://brimbox.ferbotz.com/privacy`, `/terms`).
2. **Credentials → Create OAuth client → Android:** the app's package name, plus the SHA-1 fingerprints
   of its debug and release signing keys (the app side supplies these).
3. **Credentials → Create OAuth client → Web application:** its client id is the **server client id**.
   It isn't secret. Put it in the server `.env` as `GOOGLE_CLIENT_ID=…` and recreate the container
   (`docker compose -f docker-compose.prod.yml up -d app`). Also publish it in the contract folder: the
   app passes it to Credential Manager.

## Later phases add

- **P3:** R2 credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) and
  the `worker` service.
- **P4/P5:** FCM, SES and Razorpay credentials.

### R2 setup (human, before P3)

In the Cloudflare account that already hosts `ferbotz.com`:

1. **R2 → Create bucket:** name `brimbox-files`, location hint **Asia-Pacific (APAC)**, Standard class.
   Leave public access **off**: the bucket is private, and every access is a presigned URL.
2. **Bucket → Settings → Object lifecycle rules:** abort incomplete multipart uploads after **7 days**.
3. **R2 → Manage API tokens → Create token:** permission **Object Read & Write**, scoped to
   `brimbox-files` only.
4. Put the account ID, access key ID and secret access key in the BrimBox details doc and the
   credentials registry. Never paste them into chat. Claude adds them to the server `.env` in P3.

## Standard deploys

Follow protocol 05 (`G:\My Drive\HOA Protocols\05-deployment-runbook.md`):

```bash
cd /opt/apps/brimbox/BrimBox-Backend && git pull
docker compose -f docker-compose.prod.yml up -d --build app
```

Then verify with the curls above. From P1, a schema change runs the migrate service **first**, always
with `--build`.
