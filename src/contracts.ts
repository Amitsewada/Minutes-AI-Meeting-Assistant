import { z } from 'zod';
import { meetingInputSchema, providerSchema, recordSchema } from '../shared/schema';

const uuid = z.string().uuid();
const project = z.object({ id: uuid, name: z.string(), description: z.string(), createdAt: z.string() });
const meeting = meetingInputSchema.extend({
  id: uuid, status: z.enum(['draft', 'review', 'final']), record: recordSchema.nullable(),
  provider: providerSchema.nullable(), model: z.string().nullable(), warnings: z.array(z.string()),
  version: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(),
  projectName: z.string().optional(), isDemo: z.boolean(),
});
const action = z.object({
  id: uuid, meetingId: uuid, meetingTitle: z.string(), projectId: uuid,
  description: z.string(), owner: z.string().nullable(), deadline: z.string().nullable(),
  priority: z.enum(['low', 'medium', 'high']), status: z.enum(['todo', 'in_progress', 'done']),
  evidence: z.string(), version: z.number().int().positive(),
});
const job = z.object({
  id: uuid, meetingId: uuid, status: z.enum(['queued', 'processing', 'completed', 'failed']),
  provider: providerSchema, progress: z.number().min(0).max(100), error: z.string().nullable(),
  errorCode: z.string().nullable(), fallbackAvailable: z.boolean(), createdAt: z.string(),
});
const settings = z.object({ provider: providerSchema, groqModel: z.string(), ollamaModel: z.string() });
const providers = z.object({ providers: z.array(z.object({
  provider: providerSchema, available: z.boolean(), configured: z.boolean(), message: z.string(),
  models: z.array(z.string()), selectedModel: z.string(),
})), defaultProvider: providerSchema });

export const transcriptionStatusSchema = z.object({
  available: z.boolean(), model: z.string().max(200), message: z.string().max(2000),
  maxBytes: z.number().int().positive().max(25_000_000),
  formats: z.array(z.enum(['mp3', 'wav', 'm4a', 'mp4', 'webm', 'ogg', 'flac'])).min(1).max(7),
});
export const transcriptionJobSchema = z.object({
  id: uuid, status: z.enum(['processing', 'completed', 'failed', 'cancelled']),
  transcript: z.string().max(120000).nullable(), model: z.string().max(200), provider: z.literal('groq'),
  error: z.string().max(2000).nullable(), errorCode: z.string().max(200).nullable(), createdAt: z.string(),
}).refine(value => value.status !== 'completed' || Boolean(value.transcript?.trim() && value.model.trim()));
export type TranscriptionStatus = z.infer<typeof transcriptionStatusSchema>;
export type TranscriptionJob = z.infer<typeof transcriptionJobSchema>;

// A successful HTTP status alone does not make an unexpected payload safe to render.
export function validResponse(path: string, method: string, value: unknown): boolean {
  const route = path.split('?')[0];
  const schema = route === '/projects' ? (method === 'GET' ? project.array() : project)
    : route === '/meetings' ? (method === 'GET' ? meeting.array() : meeting)
    : /^\/meetings\/[^/]+\/analyze$/.test(route) || /^\/jobs\/[^/]+$/.test(route) ? job
    : /^\/meetings\/[^/]+(?:\/finalize)?$/.test(route) ? meeting
    : route === '/actions' ? action.array()
    : /^\/actions\/[^/]+$/.test(route) ? action
    : route === '/settings' ? settings
    : route === '/transcription-status' ? transcriptionStatusSchema
    : route === '/transcriptions' || /^\/transcriptions\/[^/]+$/.test(route) ? transcriptionJobSchema
    : route === '/providers' ? providers : null;
  return !schema || schema.safeParse(value).success;
}
