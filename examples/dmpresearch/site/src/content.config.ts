import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { businessSchema } from './lib/business-schema.mjs';

const business = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/business' }),
  schema: businessSchema,
});
export const collections = { business };
