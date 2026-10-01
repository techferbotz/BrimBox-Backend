# Deploying BrimBox

BrimBox runs on the shared House of Apps EC2 box (protocols 03 + 05). The standard deploy is protocol 05.
This page covers BrimBox's first-time setup and its project-specific steps.

| | |
|---|---|
| Domain | `brimbox.ferbotz.com` (DNS on Cloudflare, **DNS only** / grey cloud, like the other apps) |
| Box | shared EC2 `13.205.128.80`, `ap-south-1` |
| Checkout | `/opt/apps/brimbox/BrimBox-Backend` |
| Compose project | `brimbox` (`docker-compose.prod.yml`) |
| Loopback port | `127.0.0.1:8094` → container `8080` |
| Repo | `github.com/techferbotz/BrimBox-Backend` (private) — to be created |

## Who does what

Following protocol 02, Claude runs deploys and migrations over SSH. A human runs anything that widens
access or touches an account. Claude prepares the exact steps for each.

| Step | Who |
|---|---|
| DNS A record `brimbox` → `13.205.128.80`, DNS only (Cloudflare dashboard) | human |
| Create the private GitHub repo `techferbotz/BrimBox-Backend` and push | human (Claude can push once it exists) |
| Decide on box capacity (below) | human |
| Clone on the box, write `.env`, build and start, nginx vhost, certbot | Claude, over SSH, after approval |
| R2 bucket + scoped API token (Cloudflare dashboard) — needed by P3 | human |
| Details doc + credentials registry entries (protocol 00) | Claude records the secrets it generates |

## Box capacity — decide before the first deploy

The box is a **t3.micro** (~1 GB RAM) already running four apps plus Postgres. Momentica's `DEPLOY.md`
says to move to a larger instance when a fifth app is added, and BrimBox is the fifth. Resizing to a
**t3.small** (2 GB) needs a stop/start, which briefly takes **every** app on the box offline, so it is a
human decision. The P0 container alone is small (one Node process). The risk grows from P1, when
BrimBox adds database load to the shared Postgres.

## First-time setup (P0)

On the box, after the DNS record exists and the repo is pushed:

```bash
sudo mkdir -p /opt/apps/brimbox && sudo chown ubuntu:ubuntu /opt/apps/brimbox
cd /opt/apps/brimbox
git clone https://github.com/techferbotz/BrimBox-Backend.git
cd BrimBox-Backend

# Server .env — never committed. P0 needs only these:
cat > .env <<'EOF'
PORT=8080
APP_PUBLIC_URL=https://brimbox.ferbotz.com
APP_HOST_PORT=8094
EOF

docker compose -f docker-compose.prod.yml up -d --build app
curl -s http://127.0.0.1:8094/        # expect: BrimBox Backend Running
```

nginx vhost (`/etc/nginx/sites-available/brimbox.ferbotz.com`; copy the exact style of the existing
vhosts on the box):

```nginx
server {
    listen 80;
    server_name brimbox.ferbotz.com;

    # File bytes never pass through the API (they go straight to R2), so bodies stay small.
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8094;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/brimbox.ferbotz.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx   # nginx -t first: a bad vhost would take down every app
sudo certbot --nginx -d brimbox.ferbotz.com
```

Verify:

```bash
curl -s https://brimbox.ferbotz.com/
curl -s https://brimbox.ferbotz.com/config
curl -sI https://brimbox.ferbotz.com/privacy | head -1
```

Then record the three legal URLs in the details doc (protocol 00/12). They are what goes into the Play
Console.

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

Follow protocol 05 (`G:\My Drive\HOA Protocols\05-deployment-runbook.md`): `git pull`, then
`docker compose -f docker-compose.prod.yml up -d --build app`, and verify with the curls above. From P1,
a schema change runs the migrate service **first**, always with `--build`.
