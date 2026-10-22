import { runAgent } from '../Agent';
import { getInstagramCaptionSchema } from '../Agent/schema';
import type { PostType } from '../models/ScheduledPost';

const TYPE_LABEL: Record<PostType, string> = {
    photo: 'a single photo post',
    carousel: 'a carousel post (several images/videos the viewer swipes through)',
    reel: 'a Reel (short vertical video)'
};

/** Drafts a caption and hashtags for a post in the account persona's voice. */
export async function generateCaption(
    character: any,
    options: { brief: string; type: PostType; languages?: string[]; defaultLanguage?: string; hashtags?: string[] }
): Promise<{ caption: string; hashtags: string[] }> {
    const charName = character?.aiPersona?.name || character?.name || "User";
    const charBio = (character?.bio || []).join(" ");
    const charTopics = (character?.topics || []).join(", ");
    const charAdjectives = (character?.adjectives || []).join(", ");
    const charStyle = [...(character?.style?.all || []), ...(character?.style?.post || [])].join(" ");
    const charLocation = character?.location || "Unknown";
    const postExamples = (character?.postExamples || []).slice(0, 5);

    const prompt = `You are ${charName} on Instagram, writing the caption for ${TYPE_LABEL[options.type]}.

            Your Bio: ${charBio}
            Your Interests: ${charTopics}
            Your Style/Tone: ${charAdjectives} ${charStyle}
            Your Location: ${charLocation}
            ${postExamples.length > 0 ? `\n[EXAMPLE POSTS]\n${postExamples.join('\n---\n')}\n` : ''}
            [WHAT THIS POST IS ABOUT]
            ${options.brief}

            ${options.hashtags?.length ? `Hashtags this account usually engages with: ${options.hashtags.map(h => `#${h.replace(/^#/, '')}`).join(' ')}` : ''}

            Guidelines:
            - Write in ${options.defaultLanguage || 'English'} unless the brief is clearly written in another language${options.languages?.length ? ` (you speak: ${options.languages.join(', ')})` : ''}.
            - Sound like a real person, not a brand or an assistant. Match your tone and style above.
            - Keep it under 1500 characters. A hook in the first line, then 1-3 short paragraphs at most.
            - Do not put hashtags in the caption field; return them separately.
            `;

    const result = await runAgent(getInstagramCaptionSchema(), prompt);
    const data = Array.isArray(result) ? result[0] : null;
    if (!data?.caption) throw new Error(typeof result === 'string' ? result : 'The AI returned no caption.');
    return {
        caption: String(data.caption).trim(),
        hashtags: (data.hashtags || []).map((h: string) => `#${String(h).replace(/^#+/, '').trim()}`).filter((h: string) => h.length > 1)
    };
}
