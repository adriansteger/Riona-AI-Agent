import { GoogleGenerativeAI } from "@google/generative-ai";
import logger from "../config/logger";
import dotenv from "dotenv";

dotenv.config();

export class JobAnalyzer {
    private apiKeys: string[];
    private currentKeyIndex: number = 0;

    constructor() {
        const keys = process.env.GEMINI_API_KEYS || "";
        this.apiKeys = keys.split(',').map(k => k.trim()).filter(k => k.length > 0);

        if (this.apiKeys.length === 0) {
            logger.warn("No GEMINI_API_KEYS found in .env. Jobs will be skipped until AI analysis is available.");
        }
    }

    private getNextKey(): string {
        if (this.apiKeys.length === 0) return "";
        const key = this.apiKeys[this.currentKeyIndex];
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
        return key;
    }

    async analyzeJob(jobTitle: string, company: string, description: string = "", targetTitle: string, targetPensum?: string): Promise<{ score: number, summary: string, isRelevant: boolean }> {
        const apiKey = this.getNextKey();
        if (!apiKey) {
            throw new Error("No Gemini API key configured (GEMINI_API_KEYS is empty).");
        }

        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            // Use 'gemini-pro' as it is the stable general model for text
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

            const pensumInstruction = targetPensum
                ? `The user specifically wants a workload of "${targetPensum}". If the job is clearly different (e.g. 100% vs 40%), score it lower.`
                : "Pensum is flexible.";

            const prompt = `
            Act as a career coach. Analyze this job posting for a user looking for "${targetTitle}" roles.
            ${pensumInstruction}
            
            Job: ${jobTitle} at ${company}
            Description Snippet: ${description.substring(0, 800)}...

            Return a valid JSON object (no markdown) with:
            - "score" (0-100 relevance). High score ONLY if title and pensum match well.
            - "summary" (one sentence summary)
            - "isRelevant" (boolean, true if score > 60)
            `;

            const result = await model.generateContent(prompt);
            const response = result.response;
            const text = response.text();

            // Clean markdown code blocks if present
            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();

            return JSON.parse(cleanText);

        } catch (error) {
            logger.error(`AI Analysis failed: ${error}`);
            // Caller skips the job without marking it processed, so it is retried next run
            throw error;
        }
    }
}
