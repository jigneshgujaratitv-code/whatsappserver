const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const clients = {};
const qrCodes = {};
const status = {};

const initializeClient = (tenantId) => {
    if (clients[tenantId]) return clients[tenantId];

    console.log(`Initializing client for tenant: ${tenantId}`);
    status[tenantId] = 'initializing';

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `tenant_${tenantId}` }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log(`QR received for ${tenantId}`);
        qrCodes[tenantId] = qr;
        status[tenantId] = 'qr_ready';
    });

    client.on('ready', () => {
        console.log(`Client is ready for ${tenantId}`);
        status[tenantId] = 'connected';
        delete qrCodes[tenantId];
    });

    client.on('authenticated', () => {
        console.log(`Authenticated for ${tenantId}`);
        status[tenantId] = 'authenticated';
    });

    client.on('auth_failure', msg => {
        console.error(`Auth failure for ${tenantId}:`, msg);
        status[tenantId] = 'auth_failure';
    });

    client.on('disconnected', (reason) => {
        console.log(`Disconnected for ${tenantId}:`, reason);
        status[tenantId] = 'disconnected';
        delete clients[tenantId];
        delete qrCodes[tenantId];
    });

    client.initialize();
    clients[tenantId] = client;
    return client;
};

app.get('/qr/:tenantId', async (req, res) => {
    const { tenantId } = req.params;
    if (!clients[tenantId]) {
        initializeClient(tenantId);
        return res.json({ status: 'initializing', msg: 'Please wait a moment and poll again for QR.' });
    }

    if (status[tenantId] === 'connected') {
        return res.json({ status: 'connected', msg: 'Already connected.' });
    }

    if (qrCodes[tenantId]) {
        try {
            const qrDataUrl = await qrcode.toDataURL(qrCodes[tenantId]);
            return res.json({ status: 'qr_ready', qr: qrDataUrl });
        } catch (err) {
            return res.status(500).json({ status: 'error', msg: 'Failed to generate QR.' });
        }
    }

    return res.json({ status: status[tenantId], msg: 'Waiting for state change...' });
});

app.get('/status/:tenantId', (req, res) => {
    const { tenantId } = req.params;
    if (!clients[tenantId]) {
        return res.json({ status: 'disconnected', msg: 'No active session.' });
    }
    return res.json({ status: status[tenantId] });
});

app.post('/send', async (req, res) => {
    const { tenantId, number, message, mediaUrl } = req.body;
    
    if (!tenantId || !number) {
        return res.status(400).json({ success: false, error: 'tenantId and number are required.' });
    }

    const client = clients[tenantId];
    if (!client || status[tenantId] !== 'connected') {
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
        console.error('Send error:', err);
        return res.status(500).json({ success: false, error: 'Failed to send message: ' + err.message });
    }
});

app.post('/logout/:tenantId', async (req, res) => {
    const { tenantId } = req.params;
    const client = clients[tenantId];
    if (client) {
        try {
            await client.logout();
        } catch(e) {}
        try {
            await client.destroy();
        } catch(e) {}
        delete clients[tenantId];
        delete qrCodes[tenantId];
        status[tenantId] = 'disconnected';
    }
    return res.json({ success: true, msg: 'Logged out successfully.' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`WhatsApp Service running on port ${PORT}`);
});
