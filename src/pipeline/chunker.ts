export interface Chunk {
  id: string;
  text: string;
  index: number;
  sourceId: string;
  metadata: Record<string, string>;
}

/**
 * Recursive text splitter. Tries to split on paragraph boundaries first,
 * then sentences, then falls back to character-level splits.
 */
export function chunkText(
  text: string,
  options: {
    sourceId: string;
    metadata: Record<string, string>;
    maxChunkSize?: number;
    overlap?: number;
  },
): Chunk[] {
  const maxSize = options.maxChunkSize ?? 1000;
  const overlap = options.overlap ?? 200;

  if (text.length <= maxSize) {
    return [
      {
        id: `${options.sourceId}:0`,
        text,
        index: 0,
        sourceId: options.sourceId,
        metadata: options.metadata,
      },
    ];
  }

  const separators = ["\n\n", "\n", ". ", " "];
  const segments = recursiveSplit(text, separators, maxSize);

  // Apply overlap window
  const chunks: Chunk[] = [];
  let position = 0;

  for (let i = 0; i < segments.length; i++) {
    let chunk = segments[i];

    // Prepend overlap from previous segment
    if (i > 0 && overlap > 0) {
      const prev = segments[i - 1];
      const overlapText = prev.slice(-overlap);
      chunk = overlapText + chunk;
    }

    chunks.push({
      id: `${options.sourceId}:${i}`,
      text: chunk,
      index: i,
      sourceId: options.sourceId,
      metadata: { ...options.metadata, chunkIndex: String(i), position: String(position) },
    });

    position += segments[i].length;
  }

  return chunks;
}

function recursiveSplit(text: string, separators: string[], maxSize: number): string[] {
  if (text.length <= maxSize) return [text];
  if (separators.length === 0) {
    // Hard split at maxSize as last resort
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += maxSize) {
      parts.push(text.slice(i, i + maxSize));
    }
    return parts;
  }

  const sep = separators[0];
  const remaining = separators.slice(1);
  const parts = text.split(sep);

  const merged: string[] = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? current + sep + part : part;
    if (candidate.length <= maxSize) {
      current = candidate;
    } else {
      if (current) merged.push(current);
      // If a single part exceeds maxSize, split it further
      if (part.length > maxSize) {
        merged.push(...recursiveSplit(part, remaining, maxSize));
        current = "";
      } else {
        current = part;
      }
    }
  }
  if (current) merged.push(current);

  return merged;
}
