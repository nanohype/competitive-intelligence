import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { logger } from "../logger.js";

export const sourceTypeSchema = z.enum([
  "changelog",
  "blog",
  "pricing",
  "careers",
  "docs",
  "general",
]);

export type SourceType = z.infer<typeof sourceTypeSchema>;

const sourceSchema = z.object({
  id: z.string().optional(),
  competitor: z.string().min(1),
  url: z.url(),
  type: sourceTypeSchema,
  selectors: z
    .object({
      content: z.string().optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
});

const sourceConfigSchema = z.object({
  sources: z.array(sourceSchema),
});

export type Source = z.infer<typeof sourceSchema> & { id: string };
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

/**
 * Load and validate sources from a JSON file.
 * Returns an empty array if the file doesn't exist.
 */
export function loadSourcesFromFile(path: string): Source[] {
  if (!existsSync(path)) {
    logger.warn("no sources file found — create one to start monitoring competitors", { path });
    return [];
  }

  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const config = sourceConfigSchema.parse(raw);

  const sources: Source[] = config.sources.map((s) => ({
    ...s,
    id: s.id ?? `${s.competitor}:${s.type}`,
  }));

  logger.info("loaded sources", { count: sources.length, path });
  return sources;
}
