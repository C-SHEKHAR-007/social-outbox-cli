import { z } from 'zod';

/** Permissions reel-cli needs (docs/plan.md §2.5). */
export const REQUIRED_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] as const;

export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
});

export const PageSchema = z.object({
  id: z.string(),
  name: z.string(),
  access_token: z.string().min(1),
  tasks: z.array(z.string()).default([]),
});
export type FacebookPage = z.infer<typeof PageSchema>;

export const AccountsResponseSchema = z.object({
  data: z.array(PageSchema),
  paging: z.object({ next: z.string().optional() }).loose().optional(),
});

export const DebugTokenSchema = z.object({
  data: z
    .object({
      is_valid: z.boolean(),
      app_id: z.string().optional(),
      type: z.string().optional(),
      scopes: z.array(z.string()).default([]),
      expires_at: z.number().optional(),
      profile_id: z.string().optional(),
      user_id: z.string().optional(),
      error: z.object({ message: z.string().optional() }).loose().optional(),
    })
    .loose(),
});
export type DebugTokenData = z.infer<typeof DebugTokenSchema>['data'];
