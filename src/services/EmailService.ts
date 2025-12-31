import nodemailer from 'nodemailer';
import logger from '../config/logger';

interface EmailConfig {
    service?: string;
    host?: string;
    port?: number;
    secure?: boolean;
    user: string;
    pass: string;
    to: string;
}

export class EmailService {
    private transporter: nodemailer.Transporter;
    private config: EmailConfig;

    constructor(config: EmailConfig) {
        this.config = config;

        const transportOptions: any = {
            auth: {
                user: config.user,
                pass: config.pass
            }
        };

        if (config.service) {
            transportOptions.service = config.service;
        } else {
            transportOptions.host = config.host;
            transportOptions.port = config.port;
            transportOptions.secure = config.secure;
        }

        this.transporter = nodemailer.createTransport(transportOptions);
    }

    async sendJobAlert(jobTitle: string, jobCompany: string, jobUrl: string, platform: string) {
        const subject = `🔥 New Job Alert: ${jobTitle} at ${jobCompany}`;
        const html = `
            <h2>New Job Found on ${platform}</h2>
            <p><strong>Title:</strong> ${jobTitle}</p>
            <p><strong>Company:</strong> ${jobCompany}</p>
            <p><strong>Link:</strong> <a href="${jobUrl}">Apply Now</a></p>
            <br />
            <p><em>Sent by Riona AI Agent</em></p>
        `;

        try {
            await this.transporter.sendMail({
                from: this.config.user,
                to: this.config.to,
                subject: subject,
                html: html
            });
            logger.info(`Email alert sent for job: ${jobTitle}`);
        } catch (error) {
            logger.error(`Failed to send email alert: ${error}`);
        }
    }
    setRecipient(email: string) {
        this.config.to = email;
        logger.info(`Email recipient updated to: ${email}`);
    }
}
