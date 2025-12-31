
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '.env') });

const API_URL = process.env.RESUMATE_API_URL;
const API_KEY = process.env.RESUMATE_API_TOKEN;

console.log("--- ResuMate API Debug Tool ---");
console.log(`URL: ${API_URL}`);
console.log(`Key: ${API_KEY ? API_KEY.substring(0, 5) + '...' : 'MISSING'}`);

async function testConnection() {
    if (!API_URL || !API_KEY) {
        console.error("Missing credentials in .env");
        return;
    }

    // 1. Test User Preferences (GET)
    // The prompt implies [API_URL]/../user-preferences. 
    // If API_URL is .../api/jobs, we want .../api/user-preferences
    const prefsUrl = API_URL.replace('/jobs', '/user-preferences');

    console.log(`\nTesting GET ${prefsUrl}...`);
    try {
        const res = await axios.get(prefsUrl, {
            headers: {
                'x-api-key': API_KEY,
                'Content-Type': 'application/json'
            }
        });
        console.log("✅ GET Success:", res.status);
        console.log("Data:", JSON.stringify(res.data, null, 2));
    } catch (err) {
        logError("GET Failed", err);
    }

    // 2. Test Job Upload (POST) - with dummy data
    console.log(`\nTesting POST ${API_URL}...`);
    try {
        const payload = {
            title: "Debug Test Job",
            company: "Debug Corp",
            url: "http://example.com/debug",
            description: "Debugging connection",
            emails: [],
            phones: [],
            location: "Remote",
            source: "debugger"
        };

        const res = await axios.post(API_URL, payload, {
            headers: {
                'x-api-key': API_KEY,
                'Content-Type': 'application/json'
            }
        });
        console.log("✅ POST Success:", res.status);
        console.log("Data:", res.data);
    } catch (err) {
        logError("POST Failed", err);
    }
}

function logError(context, err) {
    console.error(`❌ ${context}`);
    if (err.response) {
        console.error(`Status: ${err.response.status}`);
        console.error(`Headers:`, JSON.stringify(err.response.headers, null, 2));
        console.error(`Data:`, JSON.stringify(err.response.data, null, 2));
    } else {
        console.error(err.message);
    }
}

testConnection();
