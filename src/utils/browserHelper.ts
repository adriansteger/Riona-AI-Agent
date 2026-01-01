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
            command = `wmic process where "name='chrome.exe' and commandline like '%user-data-dir=${escapedPath}%'" delete`;
        } else if (platform === 'linux') {
            // pkill for Linux (Raspbian) - matches against full command line with -f
            // We look for any process with the profile folder in its arguments
            command = `pkill -f "${profileFolder}"`;
        } else {
            // macOS (darwin) or other: not fully implemented yet, just resolve
            return resolve();
        }

        exec(command, (error, stdout, stderr) => {
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
