import dotenv from "dotenv";
import logger from "./config/logger";
import { shutdown } from "./services";
import app, { botManager } from "./app";
import { initAgent } from "./Agent/index";

dotenv.config();

async function startServer() {
  try {
    await initAgent();
  } catch (err) {
    logger.error("Error during agent initialization:", err);
    process.exit(1);
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
