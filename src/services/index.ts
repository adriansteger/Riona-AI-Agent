import logger from "../config/logger";
import { BotManager } from "./BotManager";

// Graceful shutdown function
export const shutdown = async (server: any, botManager?: BotManager) => {
    try {
        logger.info("Shutting down gracefully...");

        if (botManager) {
            try {
                await botManager.stopAll();
            } catch (err) {
                logger.warn("Error stopping bots during shutdown:", err);
            }
        }

        // Attempt to close the server
        server.close(() => {
            logger.info("Closed all HTTP connections gracefully.");
            process.exit(0);
        });

        // If server hasn't closed after 10 seconds, force shutdown
        setTimeout(() => {
            logger.error("Forcing shutdown after timeout.");
            process.exit(1);
        }, 10000);

    } catch (error: any) {
        logger.error(`Error during shutdown: ${error.message}`);
        process.exit(1);
    }
};