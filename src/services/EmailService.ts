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
    from?: string; // Explicit sender address
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

        // Prioritize HOST (SMTP) over Service (e.g. Gmail) to ensure "right mail server" usage
        if (config.host) {
            transportOptions.host = config.host;
            transportOptions.port = config.port;
            transportOptions.secure = config.secure;
        } else if (config.service) {
            transportOptions.service = config.service;
        }

        this.transporter = nodemailer.createTransport(transportOptions);
    }

    async sendJobAlert(jobTitle: string, jobCompany: string, jobUrl: string, platform: string, toEmail: string) {
        const subject = `🔥 New Job Alert: ${jobTitle} at ${jobCompany}`;
        const html = `
            <h2>New Job Found on ${platform}</h2>
            <p><strong>Title:</strong> ${jobTitle}</p>
            <p><strong>Company:</strong> ${jobCompany}</p>
            <p><strong>Link:</strong> <a href="${jobUrl}">Apply Now</a></p>
            <br />
            <p><em>Sent by Riona AI Agent</em></p>
        `;

        const mailOptions = {
            from: this.config.from || this.config.user, // Use configured FROM or fallback to USER
            to: toEmail,
            subject: subject,
            html: html
        };

        try {
            await this.transporter.sendMail(mailOptions);
            logger.info(`Email sent to ${toEmail}`);
            logger.info(`Email alert sent for job: ${jobTitle}`);
        } catch (error) {
            logger.error(`Failed to send email alert: ${error}`);
        }
    }
    setRecipient(email: string) {
        this.config.to = email;
        logger.info(`Email recipient updated to: ${email}`);
    }

    async sendCaptchaAlert(username: string, url: string, toEmail: string = this.config.to) {
        if (!toEmail) {
            logger.warn("Cannot send CAPTCHA alert: No recipient email configured.");
            return;
        }

        const subject = `⚠️ ACTION REQUIRED: reCAPTCHA on ${username}`;
        const html = `
            <h2>reCAPTCHA Detected for ${username}</h2>
            <p>The bot has paused execution for account <strong>${username}</strong> because a reCAPTCHA challenge was detected.</p>
            <p><strong>URL:</strong> <a href="${url}">${url}</a></p>
            <br />
            <h3>Action Required:</h3>
            <ol>
                <li>Open the browser window for <strong>${username}</strong> (Window Title: "${username} - Instagram").</li>
                <li>Manually solve the CAPTCHA.</li>
                <li>Once the CAPTCHA is solved and the page redirects to the feed/home, the bot will automatically resume.</li>
            </ol>
            <br />
            <p><em>Sent by Riona AI Agent</em></p>
        `;

        const mailOptions = {
            from: this.config.user,
            to: toEmail,
            subject: subject,
            html: html
        };

        try {
            await this.transporter.sendMail(mailOptions);
            logger.info(`CAPTCHA alert email sent to ${toEmail} for account ${username}`);
        } catch (error) {
            logger.error(`Failed to send CAPTCHA alert email: ${error}`);
        }
    }

    async sendRateLimitAlert(username: string, url: string, toEmail: string = this.config.to) {
        if (!toEmail) {
            logger.warn("Cannot send Rate Limit alert: No recipient email configured.");
            return;
        }

        const subject = `⛔ RATE LIMITED (429): ${username} Paused`;
        const html = `
            <h2>HTTP 429 Rate Limit Detected for ${username}</h2>
            <p><strong>Status:</strong> CRITICAL PAUSE</p>
            <p>The bot encountered a "Too Many Requests" (429) error from Instagram.</p>
            <p><strong>Action Taken:</strong> The bot has entered a mandatory <strong>60-minute cool-down</strong> period to protect the account.</p>
            <p><strong>URL:</strong> ${url}</p>
            <br />
            <p><em>No action is required from you. The bot will automatically attempt to resume after 1 hour.</em></p>
            <br />
            <p><em>Sent by Riona AI Agent</em></p>
        `;

        const mailOptions = {
            from: this.config.from || this.config.user,
            to: toEmail,
            subject: subject,
            html: html
        };

        try {
            await this.transporter.sendMail(mailOptions);
            logger.info(`Rate Limit alert email sent to ${toEmail} for account ${username}`);
        } catch (error) {
            logger.error(`Failed to send Rate Limit alert email: ${error}`);
        }
    }
}
