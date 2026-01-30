/**
 * Document Chunking Module
 * 
 * Splits documents into overlapping chunks for better RAG retrieval.
 * Uses token estimation (~4 chars per token) for chunk sizing.
 */

export interface Chunk {
    text: string;
    chunkId: number;
    startIndex: number;
    endIndex: number;
}

export interface ChunkingOptions {
    chunkSize: number;      // Target tokens per chunk (~700)
    overlap: number;         // Overlap tokens between chunks (~120)
    tokenEstimate: number;   // Characters per token estimate (default: 4)
}

const DEFAULT_OPTIONS: ChunkingOptions = {
    chunkSize: 700,
    overlap: 120,
    tokenEstimate: 4,
};

/**
 * Estimates token count from character count
 * Rough approximation: ~4 characters per token for English text
 */
function estimateTokens(text: string, charsPerToken: number = 4): number {
    return Math.ceil(text.length / charsPerToken);
}

/**
 * Splits text into chunks with overlap
 * 
 * Algorithm:
 * 1. Convert chunk size and overlap to character counts
 * 2. Slide a window across the text
 * 3. Each chunk overlaps with the previous by 'overlap' tokens
 * 4. Preserves chunk order and assigns sequential IDs
 */
export function chunkDocument(
    text: string,
    options: Partial<ChunkingOptions> = {}
): Chunk[] {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    
    if (!text || text.trim().length === 0) {
        return [];
    }

    const chunks: Chunk[] = [];
    const chunkSizeChars = opts.chunkSize * opts.tokenEstimate;
    const overlapChars = opts.overlap * opts.tokenEstimate;
    const stepSize = chunkSizeChars - overlapChars;

    let chunkId = 0;
    let startIndex = 0;

    while (startIndex < text.length) {
        const endIndex = Math.min(startIndex + chunkSizeChars, text.length);
        const chunkText = text.slice(startIndex, endIndex);

        // Only add non-empty chunks
        if (chunkText.trim().length > 0) {
            chunks.push({
                text: chunkText.trim(),
                chunkId: chunkId++,
                startIndex,
                endIndex,
            });
        }

        // Move to next chunk position
        startIndex += stepSize;

        // Avoid infinite loop if stepSize is 0 or negative
        if (stepSize <= 0) {
            break;
        }
    }

    return chunks;
}

/**
 * Chunks multiple documents and returns flat list with source tracking
 */
export function chunkDocuments(
    documents: Array<{ content: string; source: string }>,
    options: Partial<ChunkingOptions> = {}
): Array<Chunk & { source: string }> {
    const allChunks: Array<Chunk & { source: string }> = [];

    for (const doc of documents) {
        const chunks = chunkDocument(doc.content, options);
        for (const chunk of chunks) {
            allChunks.push({
                ...chunk,
                source: doc.source,
            });
        }
    }

    return allChunks;
}
