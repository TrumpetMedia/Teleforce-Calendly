const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

/**
 * Keep JSON parsing for normal routes.
 * Use RAW body for webhook route only.
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

function normalizeMobile(input) {
    if (!input) return '';
    let digits = String(input).replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) return digits;
    if (digits.length === 10) return digits;
    if (digits.length > 10) return digits.slice(-10);
    return digits;
}

function normalizeCalendlyWebhook(body) {
    const event = body?.event;
    const payload = body?.payload;
    return {
        event,
        invitee: payload || null,
        eventData: payload?.scheduled_event || null,
        questionsAnswers: payload?.questions_and_answers || [],
        utm: payload?.tracking || {}
    };
}

async function getEventTypeName(eventTypeUrl) {
    if (!eventTypeUrl) return null;
    try {
        const resp = await axios.get(eventTypeUrl, {
            headers: { Authorization: `Bearer ${CALENDLY_TOKEN}` },
            timeout: 15000
        });
        return resp.data?.resource?.name || null;
    } catch {
        return null;
    }
}

function resolveSegment({ eventTypeName, utm }, requestId) {
    const name = (eventTypeName || '').toLowerCase();

    let segmentKey = 'Direct'; // default

    if (name.includes('cro')) {
        segmentKey = 'CRO';
    } else if (name.includes('performance')) {
        segmentKey = 'Performance';
    } else if (name.includes('partner')) {
        segmentKey = 'Partner';
    } else {
        // No clear event type → check UTM
        const hasUTM =
            utm &&
            (utm.utm_source ||
                utm.utm_medium ||
                utm.utm_campaign ||
                utm.utm_term ||
                utm.utm_content);

        segmentKey = hasUTM ? 'Direct' : 'Direct';
    }

    const segmentId = SEGMENT_MAPPING[segmentKey];

    console.log(`[${requestId}] 🧩 SEGMENT DECISION`);
    console.log(`[${requestId}] EventType="${eventTypeName}"`);
    console.log(`[${requestId}] UTM=`, utm || {});
    console.log(`[${requestId}] → Segment="${segmentKey}" (${segmentId})`);

    return { segmentKey, segmentId };
}


function qaMap(questionsAnswers) {
    const map = {};
    questionsAnswers.forEach(q => {
        if (!q?.question) return;
        map[q.question.toLowerCase().trim()] = q.answer;
    });
    return map;
}

function pick(map, patterns = []) {
    for (const p of patterns) {
        for (const key of Object.keys(map)) {
            if (key.includes(p)) return map[key];
        }
    }
    return '';
}

// ===================== WEBHOOK =====================
app.post('/api/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const requestId = crypto.randomUUID();

    try {
        const body = safeJsonParse(req.body);
        if (!body) return res.status(400).json({ success: false });

        const { event, invitee, eventData, questionsAnswers, utm } =
            normalizeCalendlyWebhook(body);

        if (event !== 'invitee.created') {
            return res.status(200).json({ ignored: true });
        }

        const qa = qaMap(questionsAnswers);

        const fullName = invitee.name || 'Unknown';
        const email = invitee.email || '';

        const rawMobile = pick(qa, ['mobile', 'phone', 'whatsapp', 'contact']);
        const mobile = normalizeMobile(rawMobile);

        const city = pick(qa, ['city']);
        const address = pick(qa, ['address']);

        const companyName = pick(qa, ['company']);
        const website = pick(qa, ['website']);

        // Ads / UTM mapping
        const adsName =
            utm?.utm_campaign ||
            pick(qa, ['campaign', 'ads']);

        const adsId =
            utm?.utm_term ||
            utm?.utm_content ||
            '';

        const eventTypeName = await getEventTypeName(eventData.event_type);

        const { segmentKey, segmentId } = resolveSegment(
            {
                eventTypeName,
                utm
            },
            requestId
        );

        // ===================== TELEFORCE PAYLOAD =====================
        const teleforcePayload = {
            name: fullName,
            email,
            mobile,
            city,
            address,
            company_name: companyName,   // ✅ FIXED
            website: website,             // ✅ FIXED
            ads_name: adsName,             // ✅ FIXED
            ads_id: adsId,                 // ✅ FIXED
            source: 'Calendly',
            usergroupid: ACCOUNT_ID,
            segmentid: segmentId,
            otherparams: []
        };

        // Push ALL Q/A to custom fields (for safety)
        questionsAnswers.forEach(q => {
            if (!q?.question) return;
            teleforcePayload.otherparams.push({
                meta_key: q.question
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '_')
                    .replace(/^_|_$/g, ''),
                meta_value: q.answer ?? ''
            });
        });

        // Calendly metadata
        teleforcePayload.otherparams.push(
            { meta_key: 'calendly_eventtype_name', meta_value: eventTypeName || '' },
            { meta_key: 'calendly_scheduled_start', meta_value: eventData.start_time || '' },
            { meta_key: 'calendly_scheduled_end', meta_value: eventData.end_time || '' },
            { meta_key: 'calendly_scheduledevent_uri', meta_value: eventData.uri || '' }
        );

        await axios.post(TELEFORCE_API_URL, teleforcePayload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        return res.status(200).json({
            success: true,
            segmentKey,
            segmentId
        });

    } catch (err) {
        console.error(err.message);
        // Always ACK Calendly
        return res.status(200).json({ success: false });
    }
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
