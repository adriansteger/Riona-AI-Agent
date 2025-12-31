const axios = require('axios');
require('dotenv').config();

async function testApi() {
    const apiUrl = process.env.RESUMATE_API_URL || 'http://localhost:3000/api/jobs';
    const apiKey = process.env.RESUMATE_API_TOKEN;

    // Use logic used in JobClient
    const adminUrl = apiUrl.replace('/jobs', '/admin/pro-users');
    console.log(`Testing Admin URL: ${adminUrl}`);

    try {
        const response = await axios.get(adminUrl, {
            headers: { 'x-api-key': apiKey }
        });
        console.log(`✅ SUCCESS (${response.status})`);
        console.log('Response Keys:', Object.keys(response.data));
        console.log('Response Body:', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.log(`❌ ERROR: ${error.message}`);
        if (error.response) console.log(JSON.stringify(error.response.data, null, 2));
    }
}

testApi();
