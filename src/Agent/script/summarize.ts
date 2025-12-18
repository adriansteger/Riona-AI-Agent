/* eslint-disable no-unused-vars */
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, SchemaType } from "@google/generative-ai";
import logger from "../../config/logger";

import dotenv from "dotenv";
dotenv.config();


import { geminiApiKeys } from "../../secret";


let currentApiKeyIndex = 0; // Keeps track of the current API key in use
let triedApiKeys = new Set<number>(); // Keep track of which keys we've tried in one request cycle

// Function to get the next API key in the list
const getNextApiKey = () => {
    // Add the current key to tried keys
    triedApiKeys.add(currentApiKeyIndex);

    // Move to next key
    currentApiKeyIndex = (currentApiKeyIndex + 1) % geminiApiKeys.length; // Circular rotation of API keys

    // Check if we've tried all keys
    if (triedApiKeys.size >= geminiApiKeys.length) {
        // All keys have been tried, reset tracking and throw error
        triedApiKeys.clear();
        throw new Error("All API keys have reached their rate limits. Please try again later.");
    }

    return geminiApiKeys[currentApiKeyIndex];
};

function cleanTranscript(rawTranscript: string): string {
    // Remove music or any similar tags like [Music], [Applause], etc.
    const cleaned = rawTranscript.replace(/\[.*?\]/g, '');
    const decoded = cleaned.replace(/&amp;#39;/g, "'");
    return decoded;
}

// comment
const MainPrompt = "You are tasked with transforming the YouTube video transcript into a training-ready system prompt. The goal is to format the transcript into structured data without reducing its content, and prepare it for use in training another AI model.";

const getYouTubeTranscriptSchema = () => {
    return {
        description: `Transform the YouTube video transcript into a structured format, suitable for training another AI model. Ensure the content remains intact and is formatted correctly.`,
        type: SchemaType.ARRAY,
        items: {
            type: SchemaType.OBJECT,
            properties: {
                transcriptTitle: {
                    type: SchemaType.STRING,
                    description: "The title of the YouTube video transcript.",
                    nullable: false,
                },
                fullTranscript: {
                    type: SchemaType.STRING,
                    description: "The full, unaltered YouTube video transcript.",
                    nullable: false,
                },
                contentTokenCount: {
                    type: SchemaType.STRING,
                    description: "The total number of tokens in the full transcript.",
                    nullable: false,
                },
            },
            required: [
                "transcriptTitle",
                "fullTranscript",
                "contentTokenCount",
            ],
        },
    };
};

export async function generateTrainingPrompt(transcript: string, prompt: string = MainPrompt): Promise<any> {
    let geminiApiKey = geminiApiKeys[currentApiKeyIndex];
    let currentApiKeyName = `GEMINI_API_KEY_${currentApiKeyIndex + 1}`;

    if (!geminiApiKey) {
        logger.error("No Gemini API key available.");
        return "No API key available.";
    }

    const schema = await getYouTubeTranscriptSchema();
    const generationConfig = {
        responseMimeType: "application/json",
        responseSchema: schema,
    };

    const googleAI = new GoogleGenerativeAI(geminiApiKey);
    const model = googleAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        generationConfig,
    });


    const cleanedTranscript = cleanTranscript(transcript);
    // Combine the prompt, title, and transcript for processing
    const combinedPrompt = `${prompt}\n\nVideo Transcript:\n${cleanedTranscript}`;

    try {
        const result = await model.generateContent(combinedPrompt);

        if (!result || !result.response) {
            logger.info("No response received from the AI model. || Service Unavailable");
            return "Service unavailable!";
        }

        const responseText = result.response.text();
        const data = JSON.parse(responseText);

        return data;
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes("429 Too Many Requests")) {
                logger.error(`---${currentApiKeyName} limit exhausted, switching to the next API key...`); try {
                    geminiApiKey = getNextApiKey();
                    currentApiKeyName = `GEMINI_API_KEY_${currentApiKeyIndex + 1}`;
                    return generateTrainingPrompt(transcript, prompt);
                } catch (keyError) {
                    // This catches the error when all keys have been tried
                    if (keyError instanceof Error) {
                        logger.error(keyError.message);
                        return `Error: ${keyError.message}`;
                    } else {
                        logger.error("Unknown error when trying to get next API key");
                        return "Error: All API keys have reached their rate limits. Please try again later.";
                    }
                }
            } else if (error.message.includes("503 Service Unavailable")) {
                logger.error("Service is temporarily unavailable. Retrying...");
                await new Promise(resolve => setTimeout(resolve, 5000));
                return generateTrainingPrompt(transcript, prompt);
            } else if (error.message.includes("All API keys have reached their rate limits")) {
                logger.error(error.message);
                return `Error: ${error.message}`;
            } else {
                logger.error("Error generating training prompt:", error.message);
                return `An error occurred: ${error.message}`;
            }
        } else {
            logger.error("An unknown error occurred:", error);
            return "An unknown error occurred.";
        }
    }
}
