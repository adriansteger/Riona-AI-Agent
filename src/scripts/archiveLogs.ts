import fs from 'fs';
import path from 'path';

const logDir = path.join(__dirname, '../logs');
const archiveDir = path.join(logDir, `archive_${Date.now()}`);

if (!fs.existsSync(logDir)) {
    console.log("No logs directory found.");
    process.exit(0);
}

if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
}

console.log(`Archiving logs from ${logDir} to ${archiveDir}...`);

fs.readdir(logDir, (err, files) => {
    if (err) {
        console.error("Error reading log directory:", err);
        return;
    }

    files.forEach(file => {
        const filePath = path.join(logDir, file);

        // Skip directories (specifically 'accounts' and 'system' if they already exist, and the new archive dir itself)
        if (fs.lstatSync(filePath).isDirectory()) {
            return;
        }

        const destPath = path.join(archiveDir, file);
        fs.rename(filePath, destPath, (err) => {
            if (err) {
                console.error(`Failed to move ${file}:`, err);
            } else {
                console.log(`Moved ${file}`);
            }
        });
    });
});
