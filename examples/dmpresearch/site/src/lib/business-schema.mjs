import { z } from 'zod';

// Plain text only; render with Astro escaping, never set:html.
const text = (max) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^<>\u0000-\u001f]+$/u);
export const businessSchema = z
  .object({
    name: text(100),
    description: text(300),
    city: text(100),
    email: z.email().max(254),
    design: z
      .object({
        palette: z.enum(['sand', 'graphite']),
        density: z.enum(['compact', 'comfortable']),
      })
      .strict(),
  })
  .strict();
