import mongoose, { Document, Schema } from 'mongoose';

export interface IContact extends Document {
    username: string;
    facts: string[];
    lastInteraction: Date;
}

const ContactSchema: Schema = new Schema({
    username: { type: String, required: true, unique: true, index: true },
    facts: { type: [String], default: [] },
    lastInteraction: { type: Date, default: Date.now }
});

export const Contact = mongoose.model<IContact>('Contact', ContactSchema);
