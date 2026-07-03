import { exec } from 'child_process';
import path from 'path';
import logger from '../config/logger';

/**
 * Kills any chrome.exe (Windows) or chromium (Linux) process that is using the specified userDataDir.
 * This is crucial for cleaning up zombie processes that hold file locks.
 * 
 * @param userDataDir The absolute or relative path to the user data directory
 */
export const killChromeProcessByProfile = async (userDataDir: string): Promise<void> => {
    return new Promise((resolve) => {
        const absolutePath = path.resolve(process.cwd(), userDataDir);
        const profileFolder = path.basename(absolutePath);
        const platform = process.platform;

        let command = '';

        if (platform === 'win32') {
            // WMIC command for Windows
            // wmic process where "name='chrome.exe' and commandline like '%<folder>%'" delete
            // wmic process where "name='chrome.exe' and commandline like '%user-data-dir=%<folder>%'" delete
            // We use the full absolute path to be safe, but escape backslashes for WQL
            const escapedPath = absolutePath.replace(/\\/g, '\\\\');
            // Use PowerShell with CimInstance filtering for reliability on Windows 10/11
            command = `powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'chrome.exe' AND CommandLine LIKE '%user-data-dir=${escapedPath}%'\\" | Invoke-CimMethod -MethodName Terminate"`;
        } else if (platform === 'linux') {
            // pkill for Linux (Raspbian) - matches against full command line with -f
            // We look for any process with the profile folder in its arguments
            command = `pkill -f "${profileFolder}"`;
        } else {
            // macOS (darwin) or other: not fully implemented yet, just resolve
            return resolve();
        }

        // Set a 15-second safety timeout to prevent child_process.exec from hanging indefinitely
        const timer = setTimeout(() => {
            logger.warn(`killChromeProcessByProfile command timed out for profile ${profileFolder}. Resolving to prevent hanging loop.`);
            resolve();
        }, 15000);

        exec(command, (error, stdout, stderr) => {
            clearTimeout(timer);
            if (error) {
                // Ignore "process not found" errors
                // Windows: 2147749891 or "No Instance(s) Available"
                // Linux: code 1 means no processes matched
                const isNoProcess =
                    (platform === 'win32' && (error.message.includes('No Instance(s) Available') || stderr.includes('No Instance(s) Available'))) ||
                    (platform === 'linux' && error.code === 1);

                if (!isNoProcess) {
                    // logger.warn(`Kill process command failed (${platform}): ${error.message}`);
                }
            } else {
                if (platform === 'win32' && stdout.includes('Instance deletion successful')) {
                    logger.warn(`Forcefully killed zombie Chrome process for profile: ${profileFolder}`);
                } else if (platform === 'linux') {
                    // pkill is silent on success usually
                    logger.warn(`Forcefully killed zombie Chrome process for profile: ${profileFolder}`);
                }
            }
            resolve();
        });
    });
};

/**
 * Generates a random number with a Gaussian (Normal) distribution.
 * Uses the Box-Muller transform.
 */
export const randomGaussian = (mean: number, stdDev: number): number => {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return num * stdDev + mean;
};

/**
 * Generates a human-like delay with a defined base and variant spread.
 * @param baseMs Base delay in milliseconds
 * @param varianceMs How much variance to add/subtract (in milliseconds)
 */
export const getHumanLikeDelay = (baseMs: number, varianceMs: number): number => {
    // Generate a delay with Gaussian distribution to mimic real human consistency
    // roughly 68% of delays will fall within standard deviation of varianceMs / 2
    let delay = randomGaussian(baseMs, varianceMs / 2);
    // Clamp to min/max
    delay = Math.max(baseMs - varianceMs, Math.min(baseMs + varianceMs, delay));
    return Math.floor(delay);
};

/**
 * Detects the Chrome/Chromium executable path across platforms (Windows, Linux, macOS).
 * Returns the path to the executable if found, or undefined to let Puppeteer use its default downloaded Chrome.
 */
export const getBrowserExecutablePath = async (): Promise<string | undefined> => {
    const platform = process.platform;

    if (platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\asco5', 'AppData', 'Local');
        const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
        const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

        const winPaths = [
            path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            // Fallback to Edge if Chrome is not found
            path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ];

        for (const p of winPaths) {
            try {
                const fsPromises = require('fs').promises;
                await fsPromises.access(p);
                logger.info(`Detected Windows system browser, using: ${p}`);
                return p;
            } catch (e) { /* ignore */ }
        }
    } else if (platform === 'linux') {
        const linuxPaths = [
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome'
        ];
        for (const p of linuxPaths) {
            try {
                const fsPromises = require('fs').promises;
                await fsPromises.access(p);
                logger.info(`Detected Linux system browser, using: ${p}`);
                return p;
            } catch (e) { /* ignore */ }
        }
    } else if (platform === 'darwin') {
        const macPaths = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ];
        for (const p of macPaths) {
            try {
                const fsPromises = require('fs').promises;
                await fsPromises.access(p);
                logger.info(`Detected macOS system browser, using: ${p}`);
                return p;
            } catch (e) { /* ignore */ }
        }
    }

    return undefined;
};

