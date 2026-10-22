import { runAgent } from '../Agent';
import { getInstagramDMResponseSchema } from '../Agent/schema';

export interface DmHistoryEntry {
    text: string;
    isMine: boolean;
}

export interface DmReplyInput {
    character: any;
    languages: string[];
    defaultLanguage: string;
    partnerUsername: string;
    history: DmHistoryEntry[];
    facts: string[];
}

export interface DmReply {
    response: string;
    memory_updates: string[];
}

/** Builds the persona prompt and asks the model for a reply. Shared by the auto-responder and the dashboard. */
export async function generateDmReply(input: DmReplyInput): Promise<DmReply> {
    const { character, languages, defaultLanguage, partnerUsername, history, facts } = input;

    const historyText = history.map(h => h.isMine ? `[Me]: ${h.text}` : `[Him]: ${h.text}`).join('\n');

    const charName = character?.aiPersona?.name || character?.name || "User";
    const charBio = (character?.bio || []).join(" ");
    const charLore = (character?.lore || []).join(" ");
    const charTopics = (character?.topics || []).join(", ");
    const charAdjectives = (character?.adjectives || []).join(", ");
    const charStyle = (character?.style?.all || []).join(" ");
    const charGoal = character?.goal || "Engage naturally.";
    const charLocation = character?.location || "Unknown";

    const rawExamples = character?.messageExamples || [];
    let formattedExamples = "";
    if (rawExamples.length > 0) {
        formattedExamples = "\n[EXAMPLE CONVERSATIONS]\n" + rawExamples.map((exList: any[]) => {
            return exList.map((msg: any) => {
                const role = msg.user === "{{user1}}" ? "User" : charName;
                return `${role}: ${msg.content?.text || ""}`;
            }).join('\n');
        }).join('\n---\n') + "\n";
    }

    const prompt = `You are ${charName} on Instagram.

            Your Bio: ${charBio}
            Your Lore/Backstory: ${charLore}
            Your Interests: ${charTopics}
            Your Style/Tone: ${charAdjectives} ${charStyle}
            Your Location: ${charLocation}

            Your Main Goal: ${charGoal}
            ${formattedExamples}
            You are replying to a DM thread with user: "${partnerUsername}".

            [KNOWN FACTS ABOUT USER]
            ${facts.length > 0 ? facts.map(f => `- ${f}`).join('\n') : "(None yet)"}

            [CONVERSATION HISTORY (Last 10 messages)]
            ${historyText}

             Language Configuration:
            - You speak: [${languages.join(', ')}]
            - Default Language: "${defaultLanguage}"

            Task: Generate a natural response as ${charName}.
            Guidelines:
            - IMPORTANT: ALWAYS detect the language of the user's latest incoming message. You MUST respond in that same language (e.g., if the latest message is in German, reply in German; if in French, reply in French). Fallback to your Default Language ("${defaultLanguage}") ONLY if the user's language is not one of your spoken languages.
            - UNIQUE RESPONSES: Avoid repetition. Do NOT repeat or reuse exact sentences, structures, or phrases from your previous messages in the conversation history. Every response must be unique and contextually fresh.
            - Keep it concise (1-2 sentences usually).
            - Match your specific tone and style defined above.
            - If the message is "hi" or generic, reply in character.
            - If it's spam, ignore it (return empty string or "IGNORE").
            - Do not be overly helpful assistant-like; be the character.
            - IMPORTANT: Extract any NEW permanent facts about the user (e.g. name, age, city, pets, likes, relationships) from the conversation. Return them in the 'memory_updates' field.
            `;

    const result = await runAgent(getInstagramDMResponseSchema(), prompt);
    return {
        response: result[0]?.response || '',
        memory_updates: result[0]?.memory_updates || []
    };
}
