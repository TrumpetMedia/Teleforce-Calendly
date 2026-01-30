const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

/**
 * RAW body only for webhook
 */
app.use((req, res, next) => {
    if (req.path === '/api/webhook') return next();
    return express.json()(req, res, next);
});

// ===================== ENV =====================
const TELEFORCE_API_URL = process.env.TELEFORCE_API_URL;
const ACCOUNT_ID = process.env.TELEFORCE_ACCOUNT_ID;
const CALENDLY_TOKEN = process.env.CALENDLY_ACCESS_TOKEN;

// ===================== BOOT LOG =====================
console.log('🚀 Booting service');
console.log('TELEFORCE_API_URL:', TELEFORCE_API_URL);
console.log('ACCOUNT_ID:', ACCOUNT_ID ? 'OK' : '❌ MISSING');
console.log('CALENDLY_TOKEN:', CALENDLY_TOKEN ? 'OK' : '❌ MISSING');

// ===================== SEGMENTS (FULL) =====================
const SEGMENT_MAPPING = {
    CRO: 'SEG07ootjebf6hm231767941287541',
    Performance: 'SEGtgewk86jmjb31767941272012',
    Partner: 'SEGdwjlwsm2q8k041769155100564',
    Direct: 'SEG3r649g3kk9sb41769155182361'
};

// ===================== HEALTH =====================
app.get('/health', (_, res) => res.json({ status: 'OK' }));

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
    const d = String(input).replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) return d;
    if (d.length === 10) return d;
    return d.slice(-10);
}

function qaMap(list = []) {
    const map = {};
    list.forEach(q => {
        if (q?.question) {
            map[q.question.toLowerCase().trim()] = q.answer;
        }
    });
    return map;
}

function pick(map, keywords = []) {
    for (const key of Object.keys(map)) {
        for (const k of keywords) {
            if (key.includes(k)) return map[key];
        }
    }
    return '';
}

async function getEventTypeName(url, requestId) {
    console.log(`[${requestId}] 🔎 Fetching Calendly event type`);
    if (!url) return null;

    try {
        const r = await axios.get(url, {
            headers: { Authorization: `Bearer ${CALENDLY_TOKEN}` },
            timeout: 15000
        });
        const name = r.data?.resource?.name || null;
        console.log(`[${requestId}] ✅ Event type name:`, name);
        return name;
    } catch (e) {
        console.error(`[${requestId}] ❌ Event type fetch failed`);
        console.error(e.response?.data || e.message);
        return null;
    }
}

function resolveSegment(eventTypeName, utm, requestId) {
    const name = (eventTypeName || '').toLowerCase();

    let segmentKey = 'Direct';

    if (name.includes('cro')) segmentKey = 'CRO';
    else if (name.includes('performance')) segmentKey = 'Performance';
    else if (name.includes('partner')) segmentKey = 'Partner';
    else {
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

    console.log(`[${requestId}] 🧩 SEGMENT RESOLUTION`);
    console.log(`[${requestId}] EventType:`, eventTypeName);
    console.log(`[${requestId}] Segment:`, segmentKey, segmentId);

    return { segmentKey, segmentId };
}

// ===================== WEBHOOK =====================
app.post('/api/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const requestId = crypto.randomUUID();
    console.log(`\n================ [${requestId}] WEBHOOK HIT =================`);

    try {
        const body = safeJsonParse(req.body);
        if (!body) {
            console.error(`[${requestId}] ❌ Invalid JSON`);
            return res.status(400).json({ success: false });
        }

        console.log(`[${requestId}] Event:`, body.event);

        if (body.event !== 'invitee.created') {
            console.log(`[${requestId}] Ignored`);
            return res.status(200).json({ ignored: true });
        }

        const payload = body.payload;
        const qa = qaMap(payload.questions_and_answers || []);
        const utm = payload.tracking || {};

        const fullName = payload.name || '';
        const email = payload.email || '';
        const mobile = normalizeMobile(pick(qa, ['mobile', 'phone', 'whatsapp']));

        console.log(`[${requestId}] 👤 Lead`, { fullName, email, mobile });

        const city = pick(qa, ['city']);
        const address = pick(qa, ['address']);
        const companyName = pick(qa, ['company']);
        const website = pick(qa, ['website']);

        console.log(`[${requestId}] 🏢 Business`, { companyName, website, city });

        const adsName = utm.utm_campaign || pick(qa, ['ads', 'campaign']);
        const adsId = utm.utm_term || utm.utm_content || '';

        const eventTypeName = await getEventTypeName(
            payload.scheduled_event?.event_type,
            requestId
        );

        const { segmentKey, segmentId } = resolveSegment(
            eventTypeName,
            utm,
            requestId
        );

        // ===================== TELEFORCE PAYLOAD =====================
        const teleforcePayload = {
            lead_name: fullName,
            lead_email: email,
            lead_mobile: mobile,

            segment_name: segmentKey,
            lead_source: 'Calendly',

            city: city || '',
            address: address || '',
            company_name: companyName || '',
            website: website || '',
            ads_name: adsName || '',
            ads_id: adsId || '',

            usergroupid: ACCOUNT_ID,
            segmentid: segmentId,

            otherparams: []
        };

        console.log(`[${requestId}] 📦 TELEFORCE PAYLOAD`);
        console.log(JSON.stringify(teleforcePayload, null, 2));

        console.log(`[${requestId}] 🚀 Sending to TeleForce`);
        const tfResp = await axios.post(
            TELEFORCE_API_URL,
            teleforcePayload,
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );

        console.log(`[${requestId}] ✅ TeleForce STATUS`, tfResp.status);
        console.log(`[${requestId}] ✅ TeleForce BODY`, tfResp.data);

        return res.status(200).json({ success: true });

    } catch (err) {
        console.error(`[${requestId}] ❌ ERROR`);
        console.error(err.response?.status);
        console.error(err.response?.data);
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
