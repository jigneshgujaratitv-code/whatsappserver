const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const clients = {};
const qrCodes = {};
const clientStatus = {}; // renamed to avoid conflict with http status codes

// ───────────────────────────────────────────────────────────
// HELPER: Find Chromium executable on the server
// ───────────────────────────────────────────────────────────
function findChromeExecutable() {
    // List of common Chromium/Chrome paths on Linux servers
    const candidates = [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/snap/bin/chromium',
        process.env.PUPPETEER_EXECUTABLE_PATH, // env override
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            require('fs').accessSync(candidate, require('fs').constants.X_OK);
            console.log(`[Chrome] Found executable: ${candidate}`);
            return candidate;
        } catch (_) {
            // not found or not executable, try next
        }
    }

    // Last resort: check if puppeteer bundled its own chromium
    try {
        const puppeteer = require('puppeteer');
        // puppeteer-core / puppeteer may expose executablePath
        if (typeof puppeteer.executablePath === 'function') {
            const bundled = puppeteer.executablePath();
            console.log(`[Chrome] Using puppeteer bundled: ${bundled}`);
            return bundled;
        }
    } catch (_) {}

    console.warn('[Chrome] WARNING: No Chrome/Chromium executable found!');
    console.warn('[Chrome] Install it with: sudo apt-get install -y chromium-browser');
    console.warn('[Chrome] Or set PUPPETEER_EXECUTABLE_PATH env variable');
    return undefined; // let puppeteer try its default
}

// ───────────────────────────────────────────────────────────
// HELPER: Get puppeteer launch args for headless Linux
// ───────────────────────────────────────────────────────────
function getPuppeteerArgs() {
    return [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',          // prevents crashes on small RAM
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--single-process',                 // reduces resource usage
        '--no-zygote',
        '--disable-extensions',
    ];
}

// ───────────────────────────────────────────────────────────
// HELPER: Get full puppeteer config
// ───────────────────────────────────────────────────────────
function getPuppeteerConfig() {
    const executablePath = findChromeExecutable();
    const config = {
        headless: true,  // 'new' is not supported by whatsapp-web.js 1.x
        args: getPuppeteerArgs(),
    };

    if (executablePath) {
        config.executablePath = executablePath;
    }

    return config;
}

// ───────────────────────────────────────────────────────────
// Store SSE subscribers per tenant
// ───────────────────────────────────────────────────────────
const sseSubscribers = {};

function notifySSESubscribers(tenantId, data) {
    const subs = sseSubscribers[tenantId];
    if (!subs) return;
    for (const res of subs) {
        try {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (_) {
            // connection already closed
        }
    }
}

// ───────────────────────────────────────────────────────────
// CORE: Initialize WhatsApp client for a tenant
// ───────────────────────────────────────────────────────────
const initializeClient = (tenantId) => {
    if (clients[tenantId]) return clients[tenantId];

    console.log(`[init] Initializing client for tenant: ${tenantId}`);
    clientStatus[tenantId] = 'initializing';

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `tenant_${tenantId}` }),
        puppeteer: getPuppeteerConfig(),
    });

    // ── EVENT: QR received ──
    client.on('qr', async (qr) => {
        console.log(`[qr] QR received for ${tenantId}`);
        qrCodes[tenantId] = qr;
        clientStatus[tenantId] = 'qr_ready';

        // Convert to data URL once and cache it
        try {
            const qrDataUrl = await qrcode.toDataURL(qr);
            notifySSESubscribers(tenantId, {
                status: 'qr_ready',
                qr: qrDataUrl,
            });
        } catch (err) {
            console.error(`[qr] Failed to generate QR image for ${tenantId}:`, err);
        }
    });

    // ── EVENT: Client ready (authenticated + loaded) ──
    client.on('ready', () => {
        console.log(`[ready] Client is ready for ${tenantId}`);
        clientStatus[tenantId] = 'connected';
        delete qrCodes[tenantId];
        notifySSESubscribers(tenantId, { status: 'connected' });
    });

    // ── EVENT: Authenticated (session restored) ──
    client.on('authenticated', () => {
        console.log(`[auth] Authenticated for ${tenantId}`);
        clientStatus[tenantId] = 'authenticated';
        notifySSESubscribers(tenantId, { status: 'authenticated' });
    });

    // ── EVENT: Auth failure ──
    client.on('auth_failure', (msg) => {
        console.error(`[auth_failure] Auth failure for ${tenantId}:`, msg);
        clientStatus[tenantId] = 'auth_failure';
        notifySSESubscribers(tenantId, { status: 'auth_failure', msg: String(msg) });
    });

    // ── EVENT: Disconnected ──
    client.on('disconnected', (reason) => {
        console.log(`[disconnect] Disconnected for ${tenantId}:`, reason);
        clientStatus[tenantId] = 'disconnected';
        delete clients[tenantId];
        delete qrCodes[tenantId];
        notifySSESubscribers(tenantId, { status: 'disconnected', reason });
        // Clean up SSE subscribers
        delete sseSubscribers[tenantId];
    });

    // ── EVENT: Loading screen (WhatsApp Web is booting) ──
    client.on('loading_screen', (percent, message) => {
        console.log(`[loading] ${tenantId}: ${percent}% — ${message}`);
    });

    // ── EVENT: Change state (generic state change) ──
    client.on('change_state', (state) => {
        console.log(`[state] ${tenantId}: ${state}`);
    });

    // ── Initialize with error handling ──
    client.initialize().catch((err) => {
        console.error(`[init] FAILED to initialize client for ${tenantId}:`, err.message);
        clientStatus[tenantId] = 'init_failed';
        notifySSESubscribers(tenantId, {
            status: 'init_failed',
            error: err.message,
        });
    });

    clients[tenantId] = client;
    return client;
};

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════

// ── GET /qr/:tenantId (polling endpoint — backward compatible) ──
app.get('/qr/:tenantId', async (req, res) => {
    const { tenantId } = req.params;

    if (!clients[tenantId]) {
        initializeClient(tenantId);
        return res.json({
            status: 'initializing',
            msg: 'Client is starting. Poll this endpoint every 3 seconds until you receive a QR.',
        });
    }

    if (clientStatus[tenantId] === 'connected') {
        return res.json({ status: 'connected', msg: 'Already connected.' });
    }

    if (clientStatus[tenantId] === 'init_failed') {
        return res.status(500).json({
            status: 'init_failed',
            msg: 'Failed to launch Chrome. Check server logs. Run: sudo apt-get install -y chromium-browser',
        });
    }

    if (clientStatus[tenantId] === 'auth_failure') {
        return res.json({ status: 'auth_failure', msg: 'Authentication failed. Try /logout and reconnect.' });
    }

    if (qrCodes[tenantId]) {
        try {
            const qrDataUrl = await qrcode.toDataURL(qrCodes[tenantId]);
            return res.json({ status: 'qr_ready', qr: qrDataUrl });
        } catch (err) {
            return res.status(500).json({ status: 'error', msg: 'Failed to generate QR image.' });
        }
    }

    return res.json({
        status: clientStatus[tenantId] || 'initializing',
        msg: 'Still initializing... Poll again in 3 seconds.',
    });
});

// ── GET /qr-stream/:tenantId (SSE endpoint — RECOMMENDED) ──
// This is the FIX for Root Cause #1.
// Instead of polling, the frontend opens this endpoint with EventSource
// and the server PUSHES the QR the moment it's ready.
app.get('/qr-stream/:tenantId', (req, res) => {
    const { tenantId } = req.params;

    // Set up SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx buffering
    });

    // Send initial status immediately
    res.write(`data: ${JSON.stringify({ status: 'stream_connected' })}\n\n`);

    // If client doesn't exist yet, start initialization
    if (!clients[tenantId]) {
        initializeClient(tenantId);
    }

    // If QR is already ready, send it immediately
    if (qrCodes[tenantId]) {
        qrcode.toDataURL(qrCodes[tenantId]).then((qrDataUrl) => {
            res.write(`data: ${JSON.stringify({ status: 'qr_ready', qr: qrDataUrl })}\n\n`);
        }).catch(() => {});
    }

    // If already connected, notify immediately
    if (clientStatus[tenantId] === 'connected') {
        res.write(`data: ${JSON.stringify({ status: 'connected' })}\n\n`);
    }

    // Register subscriber
    if (!sseSubscribers[tenantId]) {
        sseSubscribers[tenantId] = [];
    }
    sseSubscribers[tenantId].push(res);

    // Send heartbeat every 15 seconds to keep connection alive
    const heartbeat = setInterval(() => {
        try {
            res.write(`data: ${JSON.stringify({ status: 'heartbeat' })}\n\n`);
        } catch (_) {
            clearInterval(heartbeat);
        }
    }, 15000);

    // Clean up when client disconnects
    req.on('close', () => {
        clearInterval(heartbeat);
        if (sseSubscribers[tenantId]) {
            sseSubscribers[tenantId] = sseSubscribers[tenantId].filter((r) => r !== res);
            if (sseSubscribers[tenantId].length === 0) {
                delete sseSubscribers[tenantId];
            }
        }
    });
});

// ── GET /status/:tenantId ──
app.get('/status/:tenantId', (req, res) => {
    const { tenantId } = req.params;
    if (!clients[tenantId]) {
        return res.json({ status: 'disconnected', msg: 'No active session.' });
    }
    return res.json({ status: clientStatus[tenantId] });
});

// ── POST /send ──
app.post('/send', async (req, res) => {
    const { tenantId, number, message, mediaUrl } = req.body;

    if (!tenantId || !number) {
        return res.status(400).json({ success: false, error: 'tenantId and number are required.' });
    }

    const client = clients[tenantId];
    if (!client || clientStatus[tenantId] !== 'connected') {
        return res.status(400).json({ success: false, error: 'Client is not connected. Please scan QR first.' });
    }

    // Format number: remove +, spaces, dashes, add @c.us
    let formattedNumber = number.replace(/[^0-9]/g, '');
    if (!formattedNumber.endsWith('@c.us')) {
        formattedNumber += '@c.us';
    }

    try {
        let media = null;
        if (mediaUrl) {
            media = await MessageMedia.fromUrl(mediaUrl);
        }

        if (media) {
            await client.sendMessage(formattedNumber, media, { caption: message });
        } else if (message) {
            await client.sendMessage(formattedNumber, message);
        }

        return res.json({ success: true, msg: 'Message sent successfully.' });
    } catch (err) {
        console.error('[send] Error:', err);
        return res.status(500).json({ success: false, error: 'Failed to send message: ' + err.message });
    }
});

// ── POST /logout/:tenantId ──
app.post('/logout/:tenantId', async (req, res) => {
    const { tenantId } = req.params;
    const client = clients[tenantId];
    if (client) {
        try {
            await client.logout();
        } catch (_) {}
        try {
            await client.destroy();
        } catch (_) {}
        delete clients[tenantId];
        delete qrCodes[tenantId];
        clientStatus[tenantId] = 'disconnected';
        // Close all SSE subscribers for this tenant
        if (sseSubscribers[tenantId]) {
            for (const sub of sseSubscribers[tenantId]) {
                try { sub.end(); } catch (_) {}
            }
            delete sseSubscribers[tenantId];
        }
    }
    return res.json({ success: true, msg: 'Logged out successfully.' });
});

// ── GET /health (server health check) ──
app.get('/health', (req, res) => {
    const chromePath = findChromeExecutable();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        chromePath: chromePath || 'NOT FOUND',
        activeClients: Object.keys(clients).length,
    });
});

// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════╗`);
    console.log(`║   WhatsApp Service running on port ${PORT}       ║`);
    console.log(`╠══════════════════════════════════════════════╣`);
    console.log(`║   Endpoints:                                 ║`);
    console.log(`║   GET  /qr/:tenantId        → Poll for QR    ║`);
    console.log(`║   GET  /qr-stream/:tenantId → SSE stream ✅   ║`);
    console.log(`║   GET  /status/:tenantId     → Connection     ║`);
    console.log(`║   POST /send                  → Send message  ║`);
    console.log(`║   POST /logout/:tenantId      → Disconnect    ║`);
    console.log(`║   GET  /health                → Health check  ║`);
    console.log(`╚══════════════════════════════════════════════╝\n`);

    // Log Chrome detection on startup
    const chromePath = findChromeExecutable();
    if (chromePath) {
        console.log(`[Chrome] ✅ Found at: ${chromePath}`);
    } else {
        console.warn(`[Chrome] ❌ NOT FOUND! Install with:`);
        console.warn(`  sudo apt-get install -y chromium-browser`);
        console.warn(`  # OR`);
        console.warn(`  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium node index.js`);
    }
});
