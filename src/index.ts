import dotenv from "dotenv";
import logger from "./config/logger";
import { shutdown } from "./services";
import app, { botManager } from "./app";
import { initAgent } from "./Agent/index";
import { geminiApiKeys } from "./secret";

dotenv.config();

async function startServer() {
  try {
    await initAgent();
  } catch (err) {
    logger.error("Error during agent initialization:", err);
    process.exit(1);
  }

  if (geminiApiKeys.length === 0) {
    logger.warn("GEMINI_API_KEYS is not set. AI comments, DM replies, captions and job scoring are disabled until it is.");
  }

  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '127.0.0.1';

  const server = app.listen(port, host, () => {
    logger.info(`Server is running at http://${host}:${port}`);
    logger.info(`Bot Management Dashboard available at http://${host}:${port}`);
  });

  process.on("SIGTERM", () => {
    logger.info("Received SIGTERM signal.");
    shutdown(server, botManager);
  });
  process.on("SIGINT", () => {
    logger.info("Received SIGINT signal.");
    shutdown(server, botManager);
  });
}

startServer();
