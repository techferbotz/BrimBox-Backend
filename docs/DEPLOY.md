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

- **2026-10-01 — P0 deployed over HTTP** at `3cb36e1`. `/`, `/config` and the legal pages answer through
  nginx on the box's IP.
- **HTTPS is pending:** it needs the DNS record first (see "Remaining P0 steps").

## Who does what

Following protocol 02, Claude runs deploys and migrations over SSH. A human runs anything that widens
access or touches an account. Claude prepares the exact steps for each.

| Step | Who | Status |
|---|---|---|
| Create the private GitHub repo and push | human creates, Claude pushes | done |
| Resize the box to t3.small (stop/start) | human (the auto-mode classifier blocks agents from stopping instances) | done 2026-10-01 |
| Clone on the box, write `.env`, build and start, nginx site | Claude, over SSH | done 2026-10-01 |
| DNS A record `brimbox` → `13.205.128.80`, DNS only (Cloudflare dashboard) | human | pending |
| certbot for `brimbox.ferbotz.com` | Claude, over SSH, after DNS | pending |
| R2 bucket + scoped API token (Cloudflare dashboard) — needed by P3 | human | pending |
| Details doc + credentials registry entries (protocol 00) | Claude records the secrets it generates (none yet) | from P1 |

## The box

- **Size:** resized from t3.micro to **t3.small** (2 vCPUs, 2 GB) on 2026-10-01, when BrimBox became the
  fifth app.
  - Before: 309 MB available and 601 MB in swap.
  - After: about 1.2 GB available and no swap.
- **Elastic IP:** `13.205.128.80` is an Elastic IP, so a stop/start keeps the address and no DNS changes.
- **Boot:** every container uses `restart: unless-stopped`, and docker, postgresql and nginx are all
  enabled at boot.
- **Disk is tight:** the 19 GB root is 86% full, about 2.7 GB free. Docker holds about 5.5 GB of images no
  running container uses (possibly other apps' rollback images) plus about 1.3 GB of reclaimable build
  cache. Check `df -h /` and `docker system df` before builds. Pruning affects every app on the box, so
  ask first.

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

## Remaining P0 steps (once the DNS record exists)

```bash
# from anywhere: the name must resolve to the box before certbot can prove ownership
nslookup brimbox.ferbotz.com                     # expect 13.205.128.80

# on the box
sudo certbot --nginx -d brimbox.ferbotz.com      # adds 443 + the HTTP→HTTPS redirect
sudo nginx -t && sudo systemctl reload nginx

# verify
curl -s https://brimbox.ferbotz.com/
curl -s https://brimbox.ferbotz.com/config
curl -sI https://brimbox.ferbotz.com/privacy | head -1
```

Then record the three legal URLs in the details doc (protocol 00/12). They are what goes into the Play
Console.

Before DNS exists, test the public path by pinning the name to the IP:
`curl --resolve brimbox.ferbotz.com:80:13.205.128.80 http://brimbox.ferbotz.com/`.

## Later phases add

- **P1:** a `brimbox` database and role on the host Postgres, `DATABASE_URL` and `JWT_SECRET` in
  `.env`, and the `migrate` service. Deploys then follow protocol 05's "with a schema change" order.
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
