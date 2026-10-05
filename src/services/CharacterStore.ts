import fs from 'fs';
import path from 'path';
import logger from '../config/logger';

export interface CharacterSummary {
    filename: string;
    name: string;
    sizeBytes: number;
    updatedAt: string;
}

export class CharacterStore {
    private static instance: CharacterStore;
    private charactersDir: string;
    private buildCharactersDir: string;

    private constructor() {
        this.charactersDir = path.resolve(process.cwd(), 'src', 'Agent', 'characters');
        this.buildCharactersDir = path.resolve(process.cwd(), 'build', 'Agent', 'characters');
        if (!fs.existsSync(this.charactersDir)) {
            fs.mkdirSync(this.charactersDir, { recursive: true });
        }
    }

    public static getInstance(): CharacterStore {
        if (!CharacterStore.instance) {
            CharacterStore.instance = new CharacterStore();
        }
        return CharacterStore.instance;
    }

    public listCharacters(): CharacterSummary[] {
        try {
            if (!fs.existsSync(this.charactersDir)) return [];
            const files = fs.readdirSync(this.charactersDir);
            const results: CharacterSummary[] = [];

            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const fullPath = path.join(this.charactersDir, file);
                const stat = fs.statSync(fullPath);
                let charName = file;
                try {
                    const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
                    charName = content.name || file;
                } catch {
                    // ignore JSON parse error for summary
                }

                results.push({
                    filename: file,
                    name: charName,
                    sizeBytes: stat.size,
                    updatedAt: stat.mtime.toISOString()
                });
            }
            return results;
        } catch (error) {
            logger.error('[CharacterStore] Error listing characters:', error);
            return [];
        }
    }

    public getCharacter(filename: string): { success: boolean; data?: any; error?: string } {
        if (!this.isValidFilename(filename)) {
            return { success: false, error: 'Invalid character filename.' };
        }
        const fullPath = path.join(this.charactersDir, filename);
        if (!fs.existsSync(fullPath)) {
            return { success: false, error: 'Character not found.' };
        }
        try {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            return { success: true, data: JSON.parse(raw) };
        } catch (error: any) {
            return { success: false, error: `Failed to read character: ${error.message}` };
        }
    }

    public saveCharacter(filename: string, data: any): { success: boolean; error?: string } {
        if (!this.isValidFilename(filename)) {
            return { success: false, error: 'Invalid character filename. Must end in .json and contain safe characters.' };
        }
        try {
            const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            // Verify JSON parses
            JSON.parse(content);

            const targetPath = path.join(this.charactersDir, filename);
            fs.writeFileSync(targetPath, content, 'utf-8');

            // Mirror to build directory if build exists
            if (fs.existsSync(this.buildCharactersDir)) {
                fs.writeFileSync(path.join(this.buildCharactersDir, filename), content, 'utf-8');
            }

            return { success: true };
        } catch (error: any) {
            return { success: false, error: `Failed to save character: ${error.message}` };
        }
    }

    public deleteCharacter(filename: string): { success: boolean; error?: string } {
        if (!this.isValidFilename(filename)) {
            return { success: false, error: 'Invalid character filename.' };
        }
        const targetPath = path.join(this.charactersDir, filename);
        if (!fs.existsSync(targetPath)) {
            return { success: false, error: 'Character file does not exist.' };
        }
        try {
            fs.unlinkSync(targetPath);
            const buildTarget = path.join(this.buildCharactersDir, filename);
            if (fs.existsSync(buildTarget)) {
                fs.unlinkSync(buildTarget);
            }
            return { success: true };
        } catch (error: any) {
            return { success: false, error: `Failed to delete character: ${error.message}` };
        }
    }

    private isValidFilename(filename: string): boolean {
        return /^[a-zA-Z0-9_\-.]+\.json$/.test(filename) && !filename.includes('..');
    }
}
