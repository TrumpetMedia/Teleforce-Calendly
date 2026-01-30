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

// ===================== SEGMENTS =====================
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

    let digits = String(input).replace(/\D/g, '');

    if (digits.length === 12 && digits.startsWith('91')) {
        digits = digits.slice(2);
    }

    if (digits.length > 10) {
        digits = digits.slice(-10);
    }

    return digits.length === 10 ? digits : '';
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

        const payload = body.payload || {};
        const questionsAnswers = payload.questions_and_answers || [];
        const qa = qaMap(questionsAnswers);
        const utm = payload.tracking || {};

        const fullName = payload.name || '';
        const email = payload.email || '';

        const rawMobile = pick(qa, ['mobile', 'phone', 'whatsapp']);
        const mobile = normalizeMobile(rawMobile);
        const mobileSafe = mobile || '';

        console.log(`[${requestId}] 👤 Lead`, { fullName, email, mobile: mobileSafe });

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

        const { segmentId } = resolveSegment(eventTypeName, utm, requestId);

        // ===================== OTHERPARAMS =====================
        const otherparams = [];

        questionsAnswers.forEach(q => {
            if (!q?.question) return;

            otherparams.push({
                meta_key: q.question
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '_')
                    .replace(/^_|_$/g, ''),
                meta_value: q.answer ?? ''
            });
        });

        otherparams.push(
            { meta_key: 'company_name', meta_value: companyName },
            { meta_key: 'website', meta_value: website },
            { meta_key: 'ads_name', meta_value: adsName },
            { meta_key: 'ads_id', meta_value: adsId }
        );

        // ===================== TELEFORCE PAYLOAD =====================
        const teleforcePayload = {
            name: fullName,
            email,
            mobile: mobileSafe,

            city,
            address,

            usergroupid: ACCOUNT_ID,
            segmentid: segmentId,

            otherparams
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
