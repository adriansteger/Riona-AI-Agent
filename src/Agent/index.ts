import { GoogleGenerativeAI } from "@google/generative-ai";
import logger from "../config/logger";
import { geminiApiKeys } from "../secret";
import { handleError } from "../utils";
import { InstagramCommentSchema } from "./schema";
import fs from "fs";
import path from "path";
import * as readlineSync from "readline-sync";

// Track API key state across requests
let currentAgentApiKeyIndex = 0;
const triedAgentApiKeys = new Set<number>();

// Function to get the next API key specifically for the agent
const getNextAgentApiKey = () => {
  triedAgentApiKeys.add(currentAgentApiKeyIndex);

  // Move to next key
  currentAgentApiKeyIndex = (currentAgentApiKeyIndex + 1) % geminiApiKeys.length;

  // Check if we've tried all keys
  if (triedAgentApiKeys.size >= geminiApiKeys.length) {
    triedAgentApiKeys.clear();
    throw new Error(
      "All API keys have reached their rate limits. Please try again later."
    );
  }

  return geminiApiKeys[currentAgentApiKeyIndex];
};

export async function runAgent(
  schema: any,
  prompt: string,
  apiKeyIndex: number = currentAgentApiKeyIndex
): Promise<any> {
  let geminiApiKey = geminiApiKeys[apiKeyIndex];

  if (!geminiApiKey) {
    logger.error("No Gemini API key available.");
    return "No API key available.";
  }

  const generationConfig = {
    responseMimeType: "application/json",
    responseSchema: schema,
  };

  const googleAI = new GoogleGenerativeAI(geminiApiKey);
  const model = googleAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig,
  });

  try {
    const result = await model.generateContent(prompt);

    if (!result || !result.response) {
      logger.info("No response received from the AI model. || Service Unavailable");
      return "Service unavailable!";
    }

    const responseText = result.response.text();
    const data = JSON.parse(responseText);
    return data;
  } catch (error: any) {
    // Rotate API key on 429
    if (error instanceof Error && error.message.includes("429")) {
      logger.error(
        `---GEMINI_API_KEY_${apiKeyIndex + 1} limit exhausted, switching to the next API key...`
      );
      try {
        // Simple backoff
        await new Promise(resolve => setTimeout(resolve, 2000));
        geminiApiKey = getNextAgentApiKey();
        return runAgent(schema, prompt, currentAgentApiKeyIndex);
      } catch (keyError) {
        if (keyError instanceof Error) {
          logger.error(`API key error: ${keyError.message}`);
          return `Error: ${keyError.message}`;
        } else {
          logger.error("Unknown error when trying to get next API key");
          return "Error: All API keys have reached their rate limits. Please try again later.";
        }
      }
    }
    return handleError(error, apiKeyIndex, schema, prompt, runAgent);
  }
}

// ===== ZMIENIONE: Ładowanie Adrian's Style =====
export function chooseCharacter(characterFilename?: string): any {
  // Always start with Adrian's custom style as the BASE configuration (for limits, styles, etc.)
  let baseConfig: any = {};

  try {
    const adrianStylePath = path.join(__dirname, "..", "config", "adrian-style");
    baseConfig = require(adrianStylePath).default || require(adrianStylePath).adrianStyleConfig;
  } catch (e) {
    logger.error("Failed to load base configuration (adrian-style):", e);
    // Minimal fallback if base configuration fails
    baseConfig = {
      limits: { likesPerHour: 10, commentsPerHour: 2 },
      behavior: { enableLikes: true, enableComments: true }
    };
  }

  // If no specific filename, or explicitly adrian-style, return base (potentially with legacy merge)
  if (!characterFilename || characterFilename === 'adrian-style') {
    // Legacy behavior: try to merge Ascotech if it exists by default? 
    // Or just return base. Let's return base but keep the legacy "auto-merge" if user didn't specify.
    if (!characterFilename) {
      // ... existing legacy auto-merge logic if desired, or skip. 
      // For strictness, if no file specified, just return base. 
      logger.info("No character specified. Using default Adrian style.");
      return baseConfig;
    }
    return baseConfig;
  }

  // If a specific character file is requested, load and merge it
  try {
    const characterPath = path.join(__dirname, "characters", characterFilename);
    if (fs.existsSync(characterPath)) {
      logger.info(`Loading specific character from: ${characterPath}`);
      const charData = JSON.parse(fs.readFileSync(characterPath, 'utf-8'));

      // MERGING LOGIC
      // 1. Merge basic settings
      if (charData.settings?.behavior) {
        baseConfig.behavior = { ...baseConfig.behavior, ...charData.settings.behavior };
      }

      // 2. Merge Knowledge/Bio into focusOn
      const extraKnowledge = [
        ...(charData.bio || []).map((b: string) => `Bio: ${b}`),
        ...(charData.lore || []).map((l: string) => `Lore: ${l}`),
        ...(charData.knowledge || []).map((k: string) => `Knowledge: ${k}`)
      ];

      if (baseConfig.aiPersona?.mindset) {
        if (!baseConfig.aiPersona.mindset.focusOn) baseConfig.aiPersona.mindset.focusOn = [];
        baseConfig.aiPersona.mindset.focusOn.push(...extraKnowledge);
      }

      // 3. Merge Topics
      if (charData.topics && baseConfig.contentThemes) {
        if (!baseConfig.contentThemes.specificTopics) baseConfig.contentThemes.specificTopics = [];
        baseConfig.contentThemes.specificTopics.push(...charData.topics);
      }

      // 4. Override specific limits if present in JSON
      if (charData.limits) {
        baseConfig.limits = { ...baseConfig.limits, ...charData.limits };
      }

      logger.info(`Merged ${characterFilename} into base configuration.`);
      return baseConfig;

    } else {
      logger.warn(`Character file ${characterFilename} not found. Returning default base.`);
      return baseConfig;
    }
  } catch (e) {
    logger.error(`Error loading/merging character ${characterFilename}: ${e}`);
    return baseConfig;
  }
}

export function initAgent(): any {
  try {
    // const characterFile = 'src/Agent/characters/Ascotech.Agent.json';
    // const character = JSON.parse(fs.readFileSync(characterFile, 'utf-8'));
    const character = chooseCharacter();
    console.log("Character/Style selected:", character);
    return character;
  } catch (error) {
    console.error("Error selecting character:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  (() => {
    initAgent();
  })();
}
