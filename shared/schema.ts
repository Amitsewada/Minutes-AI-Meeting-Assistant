import { z } from 'zod';
export const providerSchema = z.enum(['groq', 'ollama', 'demo']);
export type Provider = z.infer<typeof providerSchema>;
const text = (max: number) => z.string().trim().min(1).max(max);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v, 'Use a valid calendar date');
export const evidenceSchema = z.object({ text: text(2000), evidence: text(3000) }).strict();
export const actionSchema = z.object({ description: text(2000), owner: text(200).nullable(), deadline: text(100).nullable(), evidence: text(3000), priority: z.enum(['low','medium','high']).default('medium') }).strict();
export const recordSchema = z.object({ summary: text(8000), decisions: z.array(evidenceSchema).max(100), actionItems: z.array(actionSchema).max(100), blockers: z.array(evidenceSchema).max(100), questions: z.array(evidenceSchema).max(100) }).strict();
export type MeetingRecord = z.infer<typeof recordSchema>;
export const meetingInputSchema = z.object({ title: text(160), projectId: z.string().uuid(), date: dateSchema, participants: z.array(text(100)).max(100).default([]), transcript: text(120000) }).strict();
export type MeetingInput = z.infer<typeof meetingInputSchema>;
export interface Project { id: string; name: string; description: string; createdAt: string; }
export interface Meeting extends MeetingInput { id: string; status: 'draft'|'review'|'final'; record: MeetingRecord|null; provider: Provider|null; model: string|null; warnings: string[]; version: number; createdAt: string; updatedAt: string; projectName?: string; isDemo: boolean; }
export interface ActionItem { id: string; meetingId: string; meetingTitle: string; projectId: string; description: string; owner: string|null; deadline: string|null; priority: 'low'|'medium'|'high'; status: 'todo'|'in_progress'|'done'; evidence: string; version: number; }
export interface Job { id: string; meetingId: string; status: 'queued'|'processing'|'completed'|'failed'; provider: Provider; progress: number; error: string|null; errorCode: string|null; fallbackAvailable: boolean; createdAt: string; }
export interface ProviderStatus { provider: Provider; available: boolean; configured: boolean; message: string; models: string[]; selectedModel: string; }
export interface Settings { provider: Provider; groqModel: string; ollamaModel: string; }
export interface AIResult { record: MeetingRecord; warnings: string[]; model: string; provider: Provider; }
