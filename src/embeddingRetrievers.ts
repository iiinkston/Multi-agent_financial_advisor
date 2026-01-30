import VectorStore from "./VectorStore.js";
import { chunkDocument, chunkDocuments } from "./chunker.js";
import { extractMetadata, DocumentMetadata } from "./metadataUtils.js";
import { RetrievalPipeline, RetrievalResult } from "./retrievalPipeline.js";

/**
 * Enhanced Embedding Retrievers with Chunking and Metadata
 * 
 * Features:
 * - Document chunking before embedding
 * - Rich metadata extraction
 * - Persistent vector store
 * - Hybrid retrieval with reranking
 */

interface OpenAIEmbeddingResponse {
    data: { embedding: number[] }[];
}

export default class EmbeddingRetrievers {
    private embeddingModel: string;
    private vectorStore: VectorStore;
    private retrievalPipeline: RetrievalPipeline;

    constructor(embeddingModel: string, storePath?: string) {
        this.embeddingModel = embeddingModel;
        this.vectorStore = new VectorStore(storePath);
        this.retrievalPipeline = new RetrievalPipeline(this.vectorStore);
    }

    /**
     * Embed a query string
     */
    async embedQuery(query: string): Promise<number[]> {
        return await this.embed(query);
    }

    /**
     * Embed a single document with chunking
     * 
     * Process:
     * 1. Chunk the document
     * 2. Embed each chunk
     * 3. Extract metadata for each chunk
     * 4. Store in vector store with metadata
     */
    async embedDocument(
        document: string,
        source: string,
        options?: {
            chunkSize?: number;
            overlap?: number;
            market?: string;
            type?: string;
        }
    ): Promise<void> {
        // Chunk the document
        const chunks = chunkDocument(document, {
            chunkSize: options?.chunkSize || 700,
            overlap: options?.overlap || 120,
        });

        if (chunks.length === 0) {
            console.warn(`No chunks created for document: ${source}`);
            return;
        }

        // Embed all chunks in parallel
        const embeddingPromises = chunks.map(chunk => this.embed(chunk.text));
        const embeddings = await Promise.all(embeddingPromises);

        // Create vector store items with metadata
        const items = chunks.map((chunk, index) => {
            const metadata = extractMetadata(chunk.text, source, chunk.chunkId);
            
            // Override metadata if provided in options
            if (options?.market) {
                metadata.market = options.market as any;
            }
            if (options?.type) {
                metadata.type = options.type as any;
            }

            return {
                embedding: embeddings[index],
                document: chunk.text,
                metadata,
            };
        });

        // Add all items to vector store
        await this.vectorStore.addItems(items);
        console.log(`Indexed ${items.length} chunks from ${source}`);
    }

    /**
     * Embed multiple documents with chunking
     */
    async embedDocuments(
        documents: Array<{ content: string; source: string }>,
        options?: {
            chunkSize?: number;
            overlap?: number;
        }
    ): Promise<void> {
        for (const doc of documents) {
            await this.embedDocument(doc.content, doc.source, options);
        }
    }

    /**
     * Embed text using OpenAI API
     */
    private async embed(text: string): Promise<number[]> {
        const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
        const apiKey = process.env.OPENAI_API_KEY;

        if (!apiKey) throw new Error("OPENAI_API_KEY is missing in .env");

        const response = await fetch(`${baseUrl}/embeddings`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: this.embeddingModel, // e.g. "text-embedding-3-small"
                input: text,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch embeddings: ${errorText}`);
        }

        const data = (await response.json()) as OpenAIEmbeddingResponse;
        if (!data?.data?.[0]?.embedding) {
            throw new Error("Embedding response missing data[0].embedding");
        }
        return data.data[0].embedding;
    }

    /**
     * Retrieve relevant documents using hybrid retrieval
     * 
     * Uses two-stage retrieval:
     * 1. Vector similarity search (top 20)
     * 2. Reranking with keywords and metadata (top 5)
     */
    async retrieve(query: string, topK: number = 5): Promise<RetrievalResult[]> {
        const queryEmbedding = await this.embedQuery(query);
        return await this.retrievalPipeline.retrieve(queryEmbedding, query, { topK });
    }

    /**
     * Save vector store to disk
     * Call this after indexing documents
     */
    async save(): Promise<void> {
        await this.vectorStore.save();
    }

    /**
     * Get vector store size
     */
    get size(): number {
        return this.vectorStore.size;
    }

    /**
     * Check if vector store is empty
     */
    get isEmpty(): boolean {
        return this.vectorStore.isEmpty;
    }
}
