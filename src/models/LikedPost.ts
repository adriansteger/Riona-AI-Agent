import mongoose, { Schema, Document } from 'mongoose';

export interface ILikedPost extends Document {
    username: string;
    postUrl: string;
    likedAt: Date;
}

const LikedPostSchema: Schema = new Schema({
    username: { type: String, required: true, index: true },
    postUrl: { type: String, required: true, index: true },
    likedAt: { type: Date, default: Date.now }
});

// Compound index to quickly check if a specific user liked a specific post
LikedPostSchema.index({ username: 1, postUrl: 1 }, { unique: true });

export const LikedPost = mongoose.model<ILikedPost>('LikedPost', LikedPostSchema);
