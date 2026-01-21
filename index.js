const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

/**
 * IMPORTANT:
 * For Calendly signature verification we need the RAW BODY.
 * So we add express.raw() on the webhook route only.
 * For other routes we can keep express.json().
 */
app.use((req, res, next) => {
    // Only parse JSON normally for non-webhook routes
    if (req.path === '/api/webhook') return next();
    return express.json()(req, res, next);
});

const TELEFORCE_API_URL = process.env.TELEFORCE_API_URL;
const ACCOUNT_ID = process.env.TELEFORCE_ACCOUNT_ID;
const CALENDLY_TOKEN = process.env.CALENDLY_ACCESS_TOKEN;
const CALENDLY_WEBHOOK_SIGNING_KEY = process.env.CALENDLY_WEBHOOK_SIGNING_KEY; // from developer console
const ENABLE_SIGNATURE_VERIFY = (process.env.CALENDLY_VERIFY_SIGNATURE || 'false').toLowerCase() === 'true';

// ============================================
// SEGMENT MAPPING (event name -> teleforce segment id)
// ============================================
const SEGMENT_MAPPING = {
    'CRO': 'SEG07ootjebf6hm231767941287541',
    'Performance': 'SEGtgewk86jmjb31767941272012',
    'default_segment': 'SEGplj45zsru74b1767770566946'
};

// ============================================
// FORM-SPECIFIC MAPPINGS
// ============================================
const FORM_MAPPINGS = {
    'CRO': {
        standardFields: {
            city: ['City', 'city'],
            address: ['Address', 'address']
        }
    },
    'Performance': {
        standardFields: {
            city: ['City', 'city'],
            address: ['Address', 'address']
        }
    }
};

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK' });
});

// ============================================
// HELPERS
// ============================================
function safeJsonParse(buf) {
    try {
        return JSON.parse(buf.toString('utf8'));
    } catch (e) {
        return null;
    }
}

/**
 * Calendly signature verification.
 * Header format: "t=timestamp,v1=signature"
 * Signature = HMAC-SHA256(signing_key, `${t}.${rawBody}`)
 */
function verifyCalendlySignature(rawBody, signatureHeader, signingKey) {
    if (!signatureHeader || !signingKey) return false;

    const parts = signatureHeader.split(',');
    const tPart = parts.find(p => p.trim().startsWith('t='));
    const v1Part = parts.find(p => p.trim().startsWith('v1='));
    if (!tPart || !v1Part) return false;

    const t = tPart.split('=')[1];
    const sig = v1Part.split('=')[1];

    const payloadToSign = `${t}.${rawBody}`;
    const expected = crypto
        .createHmac('sha256', signingKey)
        .update(payloadToSign, 'utf8')
        .digest('hex');

    // timing-safe compare
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Calendly real webhook shape is usually:
 * { event: "invitee.created", payload: { invitee: {...}, event: {...}, questions_and_answers: [...] } }
 *
 * Your old tests used:
 * { event: "invitee.created", data: { invitee: {...}, event: {...}, payload: { questions_and_answers: [...] } } }
 */
function normalizeCalendlyWebhook(body) {
    const event = body?.event;

    // Prefer "payload" (real Calendly)
    const payload = body?.payload;

    // fallback to "data" (your test)
    const data = body?.data;

    // Try to locate invitee/event data from either
    const invitee = payload?.invitee || data?.invitee;
    const eventData = payload?.event || data?.event;

    // Questions & answers can be in different places
    const questionsAnswers =
        payload?.questions_and_answers ||
        payload?.questions_and_answers?.collection ||
        data?.payload?.questions_and_answers ||
        [];

    return { event, invitee, eventData, questionsAnswers, raw: body };
}

function pickFirst(formAnswers, keys = []) {
    for (const k of keys) {
        if (formAnswers[k] !== undefined && formAnswers[k] !== null && String(formAnswers[k]).trim() !== '') {
            return formAnswers[k];
        }
    }
    return '';
}

// ============================================
// WEBHOOK ENDPOINT (RAW BODY + DEBUG)
// ============================================
app.post('/api/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const requestId = crypto.randomUUID();

    try {
        const rawBody = req.body?.toString('utf8') || '';
        const signatureHeader =
            req.headers['calendly-webhook-signature'] ||
            req.headers['Calendly-Webhook-Signature'];

        console.log(`\n==================== [${requestId}] WEBHOOK HIT ====================`);
        console.log(`[${requestId}] Time: ${new Date().toISOString()}`);
        console.log(`[${requestId}] Headers:`, {
            'content-type': req.headers['content-type'],
            'user-agent': req.headers['user-agent'],
            'calendly-webhook-signature': signatureHeader ? '(present)' : '(missing)'
        });
        console.log(`[${requestId}] Raw body length: ${rawBody.length}`);

        const body = safeJsonParse(req.body);
        if (!body) {
            console.log(`[${requestId}] ❌ Body is not valid JSON`);
            return res.status(400).json({ success: false, error: 'Invalid JSON body' });
        }

        console.log(`[${requestId}] Parsed body keys:`, Object.keys(body));
        console.log(`[${requestId}] Parsed body preview:`, JSON.stringify(body, null, 2).slice(0, 2500));

        // Optional signature check (recommended on prod)
        if (ENABLE_SIGNATURE_VERIFY) {
            const ok = verifyCalendlySignature(rawBody, signatureHeader, CALENDLY_WEBHOOK_SIGNING_KEY);
            console.log(`[${requestId}] Signature verification: ${ok ? '✅ OK' : '❌ FAILED'}`);
            if (!ok) return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
        } else {
            console.log(`[${requestId}] Signature verification: SKIPPED (set CALENDLY_VERIFY_SIGNATURE=true to enable)`);
        }

        const { event, invitee, eventData, questionsAnswers } = normalizeCalendlyWebhook(body);

        console.log(`[${requestId}] Event type: ${event}`);

        if (event !== 'invitee.created') {
            console.log(`[${requestId}] Ignoring event type: ${event}`);
            return res.status(200).json({ message: 'Event ignored' });
        }

        if (!invitee || !eventData) {
            console.log(`[${requestId}] ❌ Missing invitee or event data after normalization.`);
            console.log(`[${requestId}] invitee present?`, !!invitee);
            console.log(`[${requestId}] eventData present?`, !!eventData);
            return res.status(200).json({ success: false, error: 'Missing invitee/event in payload' });
        }

        // Calendly event name (your segment naming)
        const eventTitle = eventData.name || eventData?.event_type || '';
        const segmentId = SEGMENT_MAPPING[eventTitle] || SEGMENT_MAPPING.default_segment;

        console.log(`[${requestId}] Calendly eventTitle: "${eventTitle}"`);
        console.log(`[${requestId}] Resolved segmentId: "${segmentId}"`);

        // Parse form answers (array of {question, answer})
        const formAnswers = {};
        if (Array.isArray(questionsAnswers)) {
            questionsAnswers.forEach((qa) => {
                if (qa?.question) formAnswers[qa.question] = qa.answer;
            });
        }

        console.log(`[${requestId}] questionsAnswers count: ${Array.isArray(questionsAnswers) ? questionsAnswers.length : 0}`);
        console.log(`[${requestId}] formAnswers:`, formAnswers);

        const fullName =
            invitee.name ||
            [invitee.first_name, invitee.last_name].filter(Boolean).join(' ') ||
            'Unknown';

        const email = invitee.email || '';
        const mobile = invitee.text_reminder_number || invitee.phone_number || '';

        const formConfig = FORM_MAPPINGS[eventTitle];

        const city = formConfig
            ? pickFirst(formAnswers, formConfig.standardFields.city)
            : pickFirst(formAnswers, ['City', 'city']);

        const address = formConfig
            ? pickFirst(formAnswers, formConfig.standardFields.address)
            : pickFirst(formAnswers, ['Address', 'address']);

        const teleforcePayload = {
            name: fullName,
            email,
            mobile,
            city,
            address,
            usergroupid: ACCOUNT_ID,
            segmentid: segmentId,
            otherparams: []
        };

        // push all Q/A to otherparams
        if (Array.isArray(questionsAnswers)) {
            questionsAnswers.forEach((qa) => {
                if (!qa?.question) return;

                const skipFields = ['City', 'city', 'Address', 'address'];
                if (skipFields.includes(qa.question)) return;

                teleforcePayload.otherparams.push({
                    meta_key: qa.question.replace(/\s+/g, '_'),
                    meta_value: qa.answer ?? ''
                });
            });
        }

        // metadata
        teleforcePayload.otherparams.push(
            { meta_key: 'Calendly_Event_Title', meta_value: eventTitle },
            { meta_key: 'Calendly_Event_Start', meta_value: eventData.start_time || '' },
            { meta_key: 'Calendly_Invitee_Email', meta_value: email },
            { meta_key: 'Calendly_Invitee_Timezone', meta_value: invitee.timezone || '' }
        );

        console.log(`\n[${requestId}] ✅ TELEFORCE PAYLOAD READY:`);
        console.log(`[${requestId}] Teleforce URL: ${TELEFORCE_API_URL}`);
        console.log(`[${requestId}] Payload: ${JSON.stringify(teleforcePayload, null, 2)}`);

        // Send to TeleForce
        console.log(`[${requestId}] 🚀 Sending to TeleForce...`);
        const tfResp = await axios.post(TELEFORCE_API_URL, teleforcePayload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        console.log(`[${requestId}] ✅ TeleForce response status: ${tfResp.status}`);
        console.log(`[${requestId}] ✅ TeleForce response body:`, JSON.stringify(tfResp.data, null, 2));

        return res.status(200).json({
            success: true,
            message: 'Lead sent to TeleForce',
            segment: eventTitle,
            segmentid: segmentId
        });
    } catch (error) {
        console.log(`\n==================== ERROR ====================`);
        console.error(`❌ Webhook error:`, error.message);
        if (error.response?.data) {
            console.error(`❌ TeleForce/API error body:`, JSON.stringify(error.response.data, null, 2));
        }
        return res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.data
        });
    }
});

// ============================================
// (OPTIONAL) REGISTER WEBHOOK WITH CALENDLY API
// NOTE: You already registered it via curl.
// Leaving this here if you want programmatic registration.
// Calendly requires organization + scope when creating org-level subscriptions.
// ============================================
app.get('/register-webhook', async (req, res) => {
    try {
        const webhookUrl = req.query.url;
        const organization = req.query.organization; // pass your org url here
        const scope = req.query.scope || 'organization';

        if (!webhookUrl || !organization) {
            return res.status(400).json({
                error: 'Missing params',
                required: {
                    url: 'https://your-service.onrender.com/api/webhook',
                    organization: 'https://api.calendly.com/organizations/XXXX'
                }
            });
        }

        console.log(`\n🔗 Registering webhook: ${webhookUrl}`);
        console.log(`🏢 Organization: ${organization}`);
        console.log(`🔒 Scope: ${scope}`);

        const response = await axios.post(
            'https://api.calendly.com/webhook_subscriptions',
            {
                url: webhookUrl,
                events: ['invitee.created'],
                organization,
                scope
            },
            {
                headers: {
                    Authorization: `Bearer ${CALENDLY_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ Webhook registered:', JSON.stringify(response.data, null, 2));

        res.status(200).json({
            success: true,
            message: 'Webhook registered in Calendly',
            data: response.data
        });
    } catch (error) {
        console.error('❌ Registration error:', error.message);
        return res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.data
        });
    }
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🎯 Server started`);
    console.log(`✅ Listening on port: ${PORT}`);
    console.log(`📍 Webhook endpoint: /api/webhook`);
    console.log(`🔗 Health: /health`);
    console.log(`🧪 Signature verify: ${ENABLE_SIGNATURE_VERIFY ? 'ENABLED' : 'DISABLED'}`);
});
