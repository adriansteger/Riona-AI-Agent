import { exec } from 'child_process';
import path from 'path';
import logger from '../config/logger';

/**
 * Kills any chrome.exe process that is using the specified userDataDir.
 * This is crucial for cleaning up zombie processes on Windows that hold file locks.
 * 
 * @param userDataDir The absolute or relative path to the user data directory
 */
export const killChromeProcessByProfile = async (userDataDir: string): Promise<void> => {
    return new Promise((resolve) => {
        // Resolve absolute path to ensure matching correctness
        const absolutePath = path.resolve(process.cwd(), userDataDir);

        // Escape backslashes for WQL (Windows Query Language)
        // In WQL, backslashes usually need to be escaped, but for 'like' queries it can be tricky.
        // We will try to match the directory name or a significant part of the path.
        // Safest is to match the folder name if it's unique enough (like profile ID).
        const profileFolder = path.basename(absolutePath);

        // WMIC command to find and delete processes
        // wmic process where "name='chrome.exe' and commandline like '%<folder>%'" delete
        const command = `wmic process where "name='chrome.exe' and commandline like '%${profileFolder}%'" delete`;

        // logger.info(`Attempting to kill zombie Chrome processes for profile: ${profileFolder}`);

        exec(command, (error, stdout, stderr) => {
            if (error) {
                // Error code 2147749891 usually means "No Instance(s) Available" (no process found), which is good.
                // We only log real errors.
                if (!error.message.includes('No Instance(s) Available') && !stderr.includes('No Instance(s) Available')) {
                    // logger.warn(`Kill process command failed (might be already dead): ${error.message}`);
                }
            } else {
                if (stdout.includes('Instance deletion successful')) {
                    logger.warn(`Forcefully killed zombie Chrome process for profile: ${profileFolder}`);
                }
            }
            resolve();
        });
    });
};
