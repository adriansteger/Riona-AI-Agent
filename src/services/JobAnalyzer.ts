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
            logger.warn("No GEMINI_API_KEYS found in .env. AI analysis will be disabled.");
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
            return { score: 100, summary: "AI Analysis Disabled", isRelevant: true };
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
            // Fallback to accepting it so we don't miss jobs on error
            return { score: 50, summary: "AI Error - Manual Review Needed", isRelevant: true };
        }
    }
}
