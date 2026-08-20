# School Digital Notice Board

Server and TV display for the school notice board system.
Staff publish from `/admin.html`; TV boxes display `/`.

---

## Deploying to Railway

Three steps, in this order. Steps 1 and 2 are not optional — the app
refuses to expose the admin panel without a password, and warns loudly
on every page if there is no volume.

### 1. Attach a volume (makes notices survive redeploys)

Railway containers have an ephemeral filesystem. Without a volume,
every redeploy silently wipes all notices and uploaded media.

- Open the service in Railway → **Data** → **Add volume**
- Mount path: `/data`
- Redeploy

Railway sets `RAILWAY_VOLUME_MOUNT_PATH` automatically; the app reads
it. Volumes are available on Hobby and Pro plans.

Note: a service with a volume attached has a few seconds of downtime
during redeploys, because Railway will not run two deployments against
one volume. The TVs ride through this without flickering.

### 2. Set the admin password

- Service → **Variables** → add `ADMIN_PASSWORD` → a strong value
- Redeploy

Until this is set, `/admin.html` and every publishing route return 503.
This is deliberate: the previous version had no auth at all, meaning
anyone who found the URL could push content to every screen in the
school.

Log in with any username; only the password is checked.

### 3. Verify

Visit `https://<your-app>.up.railway.app/api/health`:

```json
{ "ok": true, "persistentStorage": true, "notices": 0, "uptimeSeconds": 12 }
```

If `persistentStorage` is `false`, step 1 did not take effect.

---

## Optional variables

| Variable         | Default | Purpose                                  |
|------------------|---------|------------------------------------------|
| `ADMIN_PASSWORD` | —       | Required. Protects the admin panel.      |
| `MAX_UPLOAD_MB`  | `100`   | Rejects larger uploads.                  |
| `DATA_DIR`       | —       | Storage path when not running on Railway.|

---

## Per-screen zones

All screens show notices with zone `all`. To target one screen:

1. Let the TV box connect once — it reports a device ID automatically.
2. Open `/admin.html` → **Screens** → set a zone name (e.g. `lobby`).
3. Publish a notice with that zone in the **Show on** field.

Zone assignment lives on the server, so a screen can be reassigned
from the admin panel without touching the box.

---

## Display URL options

The TV box loads the site root. Two optional query parameters:

| Parameter   | Example              | Purpose                                     |
|-------------|----------------------|---------------------------------------------|
| `device`    | `?device=lobby-01`   | Identifies the screen for zones and last-seen. |
| `overscan`  | `?overscan=3`        | Adds a 3% safe margin on TVs that crop edges. |

Combined: `https://<app>.up.railway.app/?device=lobby-01&overscan=3`

---

## Behaviour during a network outage

- The current notice stays on screen. No error page, ever.
- The page polls every 5 seconds and recovers silently.
- A small amber "Offline — last updated HH:MM" badge appears after
  ~15 seconds, so staff can tell stale content from live content.
- On a cold boot with no network, a service worker serves the last
  cached board, including images, instead of a black screen.

There is deliberately no periodic page reload. The previous version
reloaded every 13 minutes, which turned any outage lasting past the
next reload into a Chromium error page on the wall.

---

## Local development

```bash
npm install
ADMIN_PASSWORD=dev DATA_DIR=./data npm start
```

Display: http://localhost:3000
Admin:   http://localhost:3000/admin.html

---

## Storage layout

```
<volume>/
├── noticeboard.json     # notices + device→zone map (atomic writes)
└── uploads/             # uploaded images and video
```

Deleting a notice also deletes its media file, so the volume does not
fill up with orphaned uploads.
