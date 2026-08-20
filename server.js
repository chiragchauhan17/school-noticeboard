const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------
   STORAGE
   Notices and uploads live on a Railway volume mounted at /data so
   they survive restarts and redeploys. If no volume is mounted we
   fall back to a local folder and shout about it, because in that
   mode everything is wiped on every deploy.
------------------------------------------------------------------- */

// Railway sets RAILWAY_VOLUME_MOUNT_PATH automatically when a volume
// is attached. That is the only trustworthy signal: the container
// filesystem is writable either way, so simply creating /data and
// finding it writable proves nothing about whether it survives.
const FALLBACK_DIR = path.join(__dirname, 'data');

function resolveDataDir() {
    const declared = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR;

    if (declared) {
        try {
            fs.mkdirSync(declared, { recursive: true });
            fs.accessSync(declared, fs.constants.W_OK);
            return { dir: declared, persistent: true };
        } catch (e) {
            console.error(`Volume path ${declared} is not writable: ${e.message}`);
            console.error('If the service runs as a non-root user, set RAILWAY_RUN_UID=0.');
        }
    }

    fs.mkdirSync(FALLBACK_DIR, { recursive: true });
    return { dir: FALLBACK_DIR, persistent: false };
}

const { dir: DATA_DIR, persistent: PERSISTENT } = resolveDataDir();
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STATE_FILE = path.join(DATA_DIR, 'noticeboard.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!PERSISTENT) {
    console.warn('=========================================================');
    console.warn(' WARNING: no Railway volume detected.');
    console.warn(' Using ephemeral storage at ' + FALLBACK_DIR);
    console.warn(' Notices and uploaded files WILL BE LOST on every');
    console.warn(' restart or redeploy.');
    console.warn(' Fix: Railway > this service > Data > add a volume,');
    console.warn(' mount path /data. Then redeploy.');
    console.warn('=========================================================');
}

/* ------------------------------------------------------------------
   STATE
------------------------------------------------------------------- */

let state = { notices: [], devices: {} };
const lastSeen = Object.create(null); // in-memory only

function loadState() {
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        state.notices = Array.isArray(parsed.notices) ? parsed.notices : [];
        state.devices = parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {};
        console.log(`Loaded ${state.notices.length} notice(s) from disk.`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error('Could not read state file:', e.message);
        state = { notices: [], devices: {} };
    }
}

// Write to a temp file then rename, so a crash mid-write can never
// leave a half-written JSON file that fails to parse on next boot.
function saveState() {
    const tmp = STATE_FILE + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
        console.error('Failed to save state:', e.message);
    }
}

loadState();

/* ------------------------------------------------------------------
   AUTH
   Basic auth on everything that can change what the TVs display.
   If ADMIN_PASSWORD is not set, admin routes are disabled outright
   rather than left open to the internet.
------------------------------------------------------------------- */

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, res, next) {
    const password = process.env.ADMIN_PASSWORD;

    if (!password) {
        return res.status(503).type('text/plain').send(
            'Admin panel is disabled because ADMIN_PASSWORD is not set.\n\n' +
            'Railway > your service > Variables > add ADMIN_PASSWORD, then redeploy.'
        );
    }

    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');

    if (scheme === 'Basic' && encoded) {
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        const supplied = idx === -1 ? '' : decoded.slice(idx + 1);
        if (safeEqual(supplied, password)) return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="Notice Board Admin", charset="UTF-8"');
    res.status(401).type('text/plain').send('Authentication required.');
}

/* ------------------------------------------------------------------
   UPLOADS
------------------------------------------------------------------- */

const ALLOWED = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4'
};

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        // Extension comes from the verified MIME type, never from the
        // filename the browser sent. Stops someone uploading "x.html"
        // and having it served back as a live page.
        filename: (req, file, cb) =>
            cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ALLOWED[file.mimetype])
    }),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED[file.mimetype]) return cb(null, true);
        cb(new Error('Unsupported file type: ' + file.mimetype));
    }
});

/* ------------------------------------------------------------------
   MIDDLEWARE
------------------------------------------------------------------- */

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Admin panel is NOT in the public folder, so static serving can
// never hand it out before the auth check runs.
app.get(['/admin', '/admin.html'], requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, {
    maxAge: '30d',
    immutable: true // filenames are unique, so they can be cached hard
}));

/* ------------------------------------------------------------------
   PUBLIC API (what the TVs call)
------------------------------------------------------------------- */

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        persistentStorage: PERSISTENT,
        notices: state.notices.length,
        uptimeSeconds: Math.round(process.uptime())
    });
});

app.get('/api/notices', (req, res) => {
    const deviceId = String(req.query.device || '').slice(0, 64);
    let zone = 'all';

    if (deviceId) {
        lastSeen[deviceId] = Date.now();
        zone = state.devices[deviceId] || 'all';
    }

    const visible = state.notices.filter(n => n.zone === 'all' || n.zone === zone);
    res.json(visible);
});

/* ------------------------------------------------------------------
   ADMIN API
------------------------------------------------------------------- */

app.get('/api/admin/state', requireAdmin, (req, res) => {
    const devices = Object.keys(state.devices).concat(Object.keys(lastSeen));
    const seen = [...new Set(devices)].map(id => ({
        id,
        zone: state.devices[id] || 'all',
        lastSeen: lastSeen[id] || null
    }));
    res.json({ notices: state.notices, devices: seen, persistentStorage: PERSISTENT });
});

function clampDuration(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 3) return fallback;
    return Math.min(n, 600) * 1000;
}

function cleanZone(value) {
    const z = String(value || 'all').trim().slice(0, 40);
    return z || 'all';
}

app.post('/api/notices/text', requireAdmin, (req, res) => {
    const content = String(req.body.content || '').slice(0, 20000);
    if (!content.trim()) return res.status(400).send('Notice content is empty.');

    state.notices.push({
        id: crypto.randomUUID(),
        type: 'html',
        content,
        duration: clampDuration(req.body.duration, 12),
        zone: cleanZone(req.body.zone),
        createdAt: Date.now()
    });
    saveState();
    res.redirect('/admin.html');
});

app.post('/api/notices/media', requireAdmin, (req, res) => {
    upload.single('mediaFile')(req, res, err => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? `File is too large. Maximum is ${MAX_UPLOAD_MB} MB.`
                : err.message;
            return res.status(400).type('text/plain').send(msg + '\n\nPress back to try again.');
        }
        if (!req.file) return res.status(400).send('No file received.');

        state.notices.push({
            id: crypto.randomUUID(),
            type: req.file.mimetype.startsWith('video') ? 'video' : 'image',
            url: '/uploads/' + req.file.filename,
            duration: clampDuration(req.body.duration, 15),
            zone: cleanZone(req.body.zone),
            createdAt: Date.now()
        });
        saveState();
        res.redirect('/admin.html');
    });
});

app.post('/api/notices/:id/delete', requireAdmin, (req, res) => {
    const notice = state.notices.find(n => n.id === req.params.id);
    if (notice && notice.url) {
        // Remove the backing file too, or the volume slowly fills with
        // media nobody is displaying any more.
        fs.unlink(path.join(UPLOAD_DIR, path.basename(notice.url)), () => {});
    }
    state.notices = state.notices.filter(n => n.id !== req.params.id);
    saveState();
    res.redirect('/admin.html');
});

app.post('/api/notices/:id/move', requireAdmin, (req, res) => {
    const from = state.notices.findIndex(n => n.id === req.params.id);
    const dir = req.body.direction === 'up' ? -1 : 1;
    const to = from + dir;
    if (from !== -1 && to >= 0 && to < state.notices.length) {
        [state.notices[from], state.notices[to]] = [state.notices[to], state.notices[from]];
        saveState();
    }
    res.redirect('/admin.html');
});

app.post('/api/notices/clear', requireAdmin, (req, res) => {
    for (const n of state.notices) {
        if (n.url) fs.unlink(path.join(UPLOAD_DIR, path.basename(n.url)), () => {});
    }
    state.notices = [];
    saveState();
    res.redirect('/admin.html');
});

app.post('/api/devices/zone', requireAdmin, (req, res) => {
    const id = String(req.body.deviceId || '').slice(0, 64);
    if (id) {
        state.devices[id] = cleanZone(req.body.zone);
        saveState();
    }
    res.redirect('/admin.html');
});

app.listen(PORT, () => {
    console.log(`Notice board running on port ${PORT}`);
    console.log(`Storage: ${DATA_DIR} (persistent: ${PERSISTENT})`);
    console.log(`Admin auth: ${process.env.ADMIN_PASSWORD ? 'enabled' : 'DISABLED — set ADMIN_PASSWORD'}`);
});
