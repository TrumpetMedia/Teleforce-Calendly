const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const TELEFORCE_API_URL = process.env.TELEFORCE_API_URL;
const ACCOUNT_ID = process.env.TELEFORCE_ACCOUNT_ID;
const CALENDLY_TOKEN = process.env.CALENDLY_ACCESS_TOKEN;

// ============================================
// SEGMENT MAPPING
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
// WEBHOOK ENDPOINT
// ============================================
app.post('/api/webhook', async (req, res) => {
    try {
        const { event, data } = req.body;

        console.log(`\n📨 Webhook received: ${event}`);

        if (event !== 'invitee.created') {
            return res.status(200).json({ message: 'Event ignored' });
        }

        const invitee = data.invitee;
        const eventData = data.event;
        const questionsAnswers = data.payload?.questions_and_answers || [];

        // Get segment from event name
        const eventTitle = eventData.name;
        const segmentId = SEGMENT_MAPPING[eventTitle];

        console.log(`📋 Event: ${eventTitle}`);
        console.log(`📊 Segment ID: ${segmentId || 'NOT FOUND'}`);

        // Parse form answers
        const formAnswers = {};
        questionsAnswers.forEach((qa) => {
            formAnswers[qa.question] = qa.answer;
        });

        const fullName = invitee.name || 'Unknown';
        const email = invitee.email || '';
        const mobile = invitee.text_reminder_number || '';

        const formConfig = FORM_MAPPINGS[eventTitle];
        let city = '';
        let address = '';

        if (formConfig) {
            city = formAnswers[formConfig.standardFields.city[0]] ||
                formAnswers[formConfig.standardFields.city[1]] || '';
            address = formAnswers[formConfig.standardFields.address[0]] ||
                formAnswers[formConfig.standardFields.address[1]] || '';
        } else {
            city = formAnswers['City'] || formAnswers['city'] || '';
            address = formAnswers['Address'] || formAnswers['address'] || '';
        }

        // Build TeleForce payload
        const teleforcePayload = {
            name: fullName,
            email: email,
            mobile: mobile,
            city: city,
            address: address,
            usergroupid: ACCOUNT_ID,
            segmentid: segmentId || '',
            otherparams: []
        };

        // Add custom fields
        questionsAnswers.forEach((qa) => {
            const key = qa.question.replace(/\s+/g, '_');
            const skipFields = ['City', 'city', 'Address', 'address'];

            if (!skipFields.includes(qa.question)) {
                teleforcePayload.otherparams.push({
                    meta_key: key,
                    meta_value: qa.answer
                });
            }
        });

        // Add metadata
        teleforcePayload.otherparams.push(
            {
                meta_key: 'Segment_Name',
                meta_value: eventTitle
            },
            {
                meta_key: 'Scheduled_Time',
                meta_value: eventData.start_time
            },
            {
                meta_key: 'Timezone',
                meta_value: invitee.timezone
            }
        );

        console.log('\n✅ Payload:', JSON.stringify(teleforcePayload, null, 2));

        // Send to TeleForce
        console.log(`🚀 Sending to TeleForce...`);

        const response = await axios.post(TELEFORCE_API_URL, teleforcePayload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });

        console.log('✅ Success:', response.data);

        res.status(200).json({
            success: true,
            message: 'Lead sent to TeleForce',
            segment: eventTitle
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// REGISTER WEBHOOK WITH CALENDLY API
// ============================================
app.get('/register-webhook', async (req, res) => {
    try {
        const webhookUrl = req.query.url;

        if (!webhookUrl) {
            return res.status(400).json({ error: 'URL parameter required' });
        }

        console.log(`\n🔗 Registering webhook: ${webhookUrl}`);

        const response = await axios.post(
            'https://api.calendly.com/webhook_subscriptions',
            {
                url: webhookUrl,
                events: ['invitee.created']
            },
            {
                headers: {
                    'Authorization': `Bearer ${CALENDLY_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ Webhook registered:', response.data);

        res.status(200).json({
            success: true,
            message: 'Webhook registered in Calendly',
            data: response.data
        });

    } catch (error) {
        console.error('❌ Registration error:', error.message);
        res.status(500).json({
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
    console.log(`\n🎯 Server running on http://localhost:${PORT}`);
    console.log(`📍 Webhook endpoint: http://localhost:${PORT}/api/webhook`);
    console.log(`🔗 Register webhook: http://localhost:${PORT}/register-webhook?url=YOUR_PUBLIC_URL`);
});
