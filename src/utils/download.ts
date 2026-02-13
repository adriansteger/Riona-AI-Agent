import fs from 'fs';

import logger from '../config/logger';

import axios from 'axios';

export const download = async function (uri: string, filename: string, callback: (err?: Error) => void): Promise<void> {
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const options: any = {
        responseType: 'stream'
    };

    if (proxy) {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        options.httpsAgent = new HttpsProxyAgent(proxy);
        options.proxy = false;
    }

    try {
        const response = await axios.get(uri, options);
        const writer = fs.createWriteStream(filename);

        response.data.pipe(writer);

        writer.on('finish', () => {
            logger.info(`File downloaded successfully from ${uri} to ${filename}`);
            callback();
        });

        writer.on('error', (err: any) => {
            logger.error(`Error writing file to ${filename}: ${err.message}`);
            callback(err);
        });

    } catch (err: any) {
        logger.error(`Error downloading file from ${uri}: ${err.message}`);
        callback(err);
    }
};




