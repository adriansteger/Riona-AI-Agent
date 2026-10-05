import express, { Application } from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import session from 'express-session';
import path from 'path';
import fs from 'fs';

import logger, { setupErrorHandlers } from "./config/logger";
import { setup_HandleError } from "./utils";
import { connectDB } from "./config/db";
import apiRoutes from "./routes/api";
import dashboardRoutes from "./routes/dashboard";
import { BotManager } from "./services/BotManager";

// Set up process-level error handlers
setupErrorHandlers();

// Initialize environment variables
dotenv.config();

// Initialize Express app
const app: Application = express();

// Connect to the database
connectDB();

// Middleware setup
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "connect-src": ["'self'"]
    },
  },
}));

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: "1kb" }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 2 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true
  },
}));

// Serve static frontend build if present
const frontendPath = path.join(__dirname, '../frontend/dist');
const frontendExists = fs.existsSync(frontendPath);

if (frontendExists) {
  app.use(express.static(frontendPath));
}

// API Routes
app.use('/api/dashboard', dashboardRoutes);
app.use('/api', apiRoutes);

// SPA Catch-All
app.get('*', (_req, res) => {
  if (frontendExists && fs.existsSync(path.join(frontendPath, 'index.html'))) {
    res.sendFile('index.html', { root: frontendPath });
  } else {
    res.status(200).json({ status: 'API is running', message: 'Frontend not found or not built yet.' });
  }
});

// Initialize and bootstrap BotManager
export const botManager = BotManager.getInstance();

try {
  botManager.bootstrap();
} catch (error) {
  setup_HandleError(error, "Error bootstrapping bots:");
}

// Error handling
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
