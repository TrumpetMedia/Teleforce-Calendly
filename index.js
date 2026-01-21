const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

/**
 * Keep JSON parsing for normal routes.
 * Use RAW body for webhook route only (so logs are exact and signature verification can be added later).
 */
app.use((req, res, next) => {
    if (req.path === '/api/webhook') return next();
    return express.json()(req, res, next);
});

const TELEFORCE_API_URL = process.env.TELEFORCE_API_URL;
const ACCOUNT_ID = process.env.TELEFORCE_ACCOUNT_ID;
const CALENDLY_TOKEN = process.env.CALENDLY_ACCESS_TOKEN;

// ===================== SEGMENT MAPPING =====================
const SEGMENT_MAPPING = {
    CRO: 'SEG07ootjebf6hm231767941287541',
    Performance: 'SEGtgewk86jmjb31767941272012',
    default_segment: 'SEGplj45zsru74b1767770566946'
};

// ===================== FORM FIELD MAPPING =====================
const FORM_MAPPINGS = {
    CRO: { standardFields: { city: ['City', 'city'], address: ['Address', 'address'] } },
    Performance: { standardFields: { city: ['City', 'city'], address: ['Address', 'address'] } }
};

// ===================== HEALTH =====================
app.get('/health', (req, res) => res.status(200).json({ status: 'OK' }));

// ===================== HELPERS =====================
function safeJsonParse(buf) {
    try {
        return JSON.parse(buf.toString('utf8'));
    } catch {
        return null;
    }
}

function pickFirst(formAnswers, keys = []) {
    for (const k of keys) {
        const v = formAnswers?.[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return '';
}

/**
 * Calendly invitee.created payload (what your logs show):
 * body.payload has invitee info directly: name, email, questions_and_answers...
 * body.payload.scheduled_event has event info including event_type (URL).
 */
function normalizeCalendlyWebhook(body) {
    const event = body?.event;
    const payload = body?.payload;

    // For invitee.created: payload itself is effectively the invitee resource
    const invitee = payload || null;

    // scheduled_event object is inside payload
    const eventData = payload?.scheduled_event || null;

    const questionsAnswers = payload?.questions_and_answers || [];

    return { event, invitee, eventData, questionsAnswers, raw: body };
}

/**
 * Fetch Calendly Event Type name from the event_type URL
 * Example event_type URL:
 * https://api.calendly.com/event_types/XXXX
 */
async function getEventTypeName(eventTypeUrl, requestId) {
    try {
        if (!eventTypeUrl) return null;
        console.log(`[${requestId}] 🔎 Fetching event type name from: ${eventTypeUrl}`);

        const resp = await axios.get(eventTypeUrl, {
            headers: { Authorization: `Bearer ${CALENDLY_TOKEN}` },
            timeout: 15000
        });

        const name = resp.data?.resource?.name || null;
        console.log(`[${requestId}] ✅ Event type name resolved: ${name}`);
        return name;
    } catch (err) {
        console.log(`[${requestId}] ❌ Failed to fetch event type name: ${err.message}`);
        if (err.response?.data) {
            console.log(`[${requestId}] Calendly error body: ${JSON.stringify(err.response.data).slice(0, 1200)}`);
        }
        return null;
    }
}

/**
 * Decide TeleForce segment based on Calendly event type name.
 * Your event names are like:
 * - "Website CRO Meet"  -> segment CRO
 * - "Performance marketing ..." -> segment Performance
 */
function resolveSegment(eventTypeName, requestId) {
    const name = (eventTypeName || '').toLowerCase();

    let segmentKey = null;
    if (name.includes('cro')) segmentKey = 'CRO';
    else if (name.includes('performance')) segmentKey = 'Performance';

    const segmentId = SEGMENT_MAPPING[segmentKey] || SEGMENT_MAPPING.default_segment;

    console.log(`[${requestId}] 🧩 Segment resolution:`);
    console.log(`[${requestId}] eventTypeName="${eventTypeName}" => segmentKey="${segmentKey}" => segmentId="${segmentId}"`);

    return { segmentKey: segmentKey || 'default_segment', segmentId };
}

// ===================== WEBHOOK =====================
app.post('/api/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const requestId = crypto.randomUUID();

    try {
        const rawBody = req.body?.toString('utf8') || '';
        console.log(`\n==================== [${requestId}] WEBHOOK HIT ====================`);
        console.log(`[${requestId}] Time: ${new Date().toISOString()}`);
        console.log(`[${requestId}] Headers:`, {
            'content-type': req.headers['content-type'],
            'user-agent': req.headers['user-agent']
        });
        console.log(`[${requestId}] Raw body length: ${rawBody.length}`);

        const body = safeJsonParse(req.body);
        if (!body) {
            console.log(`[${requestId}] ❌ Invalid JSON received`);
            return res.status(400).json({ success: false, error: 'Invalid JSON body' });
        }

        console.log(`[${requestId}] Parsed body keys:`, Object.keys(body));
        console.log(`[${requestId}] Body preview:`, JSON.stringify(body, null, 2).slice(0, 2500));

        const { event, invitee, eventData, questionsAnswers } = normalizeCalendlyWebhook(body);

        console.log(`[${requestId}] Event type: ${event}`);
        if (event !== 'invitee.created') {
            console.log(`[${requestId}] Ignoring event type: ${event}`);
            return res.status(200).json({ message: 'Event ignored' });
        }

        if (!invitee) {
            console.log(`[${requestId}] ❌ Missing invitee after normalization`);
            return res.status(200).json({ success: false, error: 'Missing invitee in payload' });
        }

        if (!eventData) {
            console.log(`[${requestId}] ❌ Missing scheduled_event after normalization`);
            return res.status(200).json({ success: false, error: 'Missing scheduled_event in payload' });
        }

        // invitee fields (from payload)
        const fullName = invitee.name || 'Unknown';
        const email = invitee.email || '';
        const mobile =
            (questionsAnswers.find(q => (q.question || '').toLowerCase().includes('mobile'))?.answer || '')
                .replace(/\s+/g, ' ')
                .trim();

        console.log(`[${requestId}] Invitee parsed: name="${fullName}", email="${email}", mobile="${mobile}"`);

        // resolve event type name (needed for segment mapping)
        const eventTypeUrl = eventData.event_type; // URL string
        const eventTypeName = await getEventTypeName(eventTypeUrl, requestId);

        const { segmentKey, segmentId } = resolveSegment(eventTypeName, requestId);

        // parse Q/A into map
        const formAnswers = {};
        if (Array.isArray(questionsAnswers)) {
            questionsAnswers.forEach((qa) => {
                if (qa?.question) formAnswers[qa.question] = qa.answer;
            });
        }

        console.log(`[${requestId}] questionsAnswers count: ${Array.isArray(questionsAnswers) ? questionsAnswers.length : 0}`);

        // city/address if present in Q/A (optional)
        const formConfig = FORM_MAPPINGS[segmentKey]; // map by segment key
        const city = formConfig ? pickFirst(formAnswers, formConfig.standardFields.city) : pickFirst(formAnswers, ['City', 'city']);
        const address = formConfig ? pickFirst(formAnswers, formConfig.standardFields.address) : pickFirst(formAnswers, ['Address', 'address']);

        // Build TeleForce payload
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

        // Push all Q/A as otherparams (keep everything)
        if (Array.isArray(questionsAnswers)) {
            questionsAnswers.forEach((qa) => {
                if (!qa?.question) return;
                teleforcePayload.otherparams.push({
                    meta_key: qa.question.replace(/\s+/g, '_'),
                    meta_value: qa.answer ?? ''
                });
            });
        }

        // Add Calendly metadata
        teleforcePayload.otherparams.push(
            { meta_key: 'Calendly_EventType_Name', meta_value: eventTypeName || '' },
            { meta_key: 'Calendly_ScheduledEvent_URI', meta_value: eventData.uri || '' },
            { meta_key: 'Calendly_Scheduled_Start', meta_value: eventData.start_time || '' },
            { meta_key: 'Calendly_Scheduled_End', meta_value: eventData.end_time || '' }
        );

        console.log(`\n[${requestId}] ✅ TELEFORCE PAYLOAD:`);
        console.log(`[${requestId}] URL: ${TELEFORCE_API_URL}`);
        console.log(`[${requestId}] Payload: ${JSON.stringify(teleforcePayload, null, 2)}`);

        // Send to TeleForce
        console.log(`[${requestId}] 🚀 Sending to TeleForce...`);
        const tfResp = await axios.post(TELEFORCE_API_URL, teleforcePayload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        console.log(`[${requestId}] ✅ TeleForce status: ${tfResp.status}`);
        console.log(`[${requestId}] ✅ TeleForce body: ${JSON.stringify(tfResp.data, null, 2)}`);

        return res.status(200).json({
            success: true,
            message: 'Lead sent to TeleForce',
            segmentKey,
            segmentid: segmentId
        });
    } catch (error) {
        console.log(`\n==================== [${requestId}] ERROR ====================`);
        console.error(`[${requestId}] ❌ Error:`, error.message);
        if (error.response?.data) {
            console.error(`[${requestId}] ❌ API error body:`, JSON.stringify(error.response.data, null, 2));
        }
        return res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.data
        });
    }
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🎯 Server started`);
    console.log(`✅ Listening on port: ${PORT}`);
    console.log(`📍 Webhook endpoint: /api/webhook`);
    console.log(`🔗 Health: /health`);
});
