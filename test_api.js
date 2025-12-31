
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '.env') });
require('dotenv').config();

async function testApi() {
    const apiUrl = process.env.RESUMATE_API_URL;
    const apiKey = process.env.RESUMATE_API_TOKEN;

    async function testApi() {
        const apiUrl = process.env.RESUMATE_API_URL;
        const apiKey = process.env.RESUMATE_API_TOKEN;

        const adminUrl = apiUrl.replace('/jobs', '/admin/pro-users');
        console.log(`Testing Admin URL: ${adminUrl}`);

        try {
            const response = await axios.get(adminUrl, {
                headers: { 'x-api-key': apiKey }
            });
            console.log(`✅ SUCCESS (${response.status})`);
            console.log("Users found:", response.data.data ? response.data.data.length : 0);
            console.log(JSON.stringify(response.data, null, 2));
        } catch (error) {
            console.log(`❌ ERROR: ${error.response ? error.response.status : error.message}`);
            if (error.response) console.log(JSON.stringify(error.response.data, null, 2));
        }
    }

    testApi();
