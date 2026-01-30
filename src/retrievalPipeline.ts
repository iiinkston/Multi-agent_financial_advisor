import VectorStore, { VectorStoreItem } from "./VectorStore.js";
import { DocumentMetadata, QueryIntent, extractQueryIntent } from "./metadataUtils.js";

/**
 * Retrieval Pipeline with Two-Stage Retrieval and Reranking
 * 
 * Stage 1: Vector similarity search (top 20 candidates)
 * Stage 2: Reranking with keyword + metadata weighting (top 5)
 */

export interface RetrievalResult {
    document: string;
    metadata: DocumentMetadata;
    score: number;
    rerankScore?: number; // Final score after reranking
}

export interface RetrievalOptions {
    topK: number;              // Final number of results (default: 5)
    initialK: number;          // Initial vector search results (default: 20)
    metadataBoost: number;     // Boost score for metadata matches (default: 0.2)
    keywordBoost: number;      // Boost score for keyword matches (default: 0.15)
}

const DEFAULT_OPTIONS: RetrievalOptions = {
    topK: 5,
    initialK: 20,
    metadataBoost: 0.2,
    keywordBoost: 0.15,
};

/**
 * Hybrid Retrieval Pipeline
 * 
 * Implements:
 * 1. Vector similarity search (cosine similarity)
 * 2. Metadata-aware filtering
 * 3. Keyword-based reranking
 * 4. Metadata matching boost
 */
export class RetrievalPipeline {
    private vectorStore: VectorStore;
    private options: RetrievalOptions;

    constructor(vectorStore: VectorStore, options: Partial<RetrievalOptions> = {}) {
        this.vectorStore = vectorStore;
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Main retrieval method
     * 
     * @param queryEmbedding - Query vector embedding
     * @param query - Original query text (for keyword matching)
     * @param options - Override default retrieval options
     * @returns Top K retrieval results with scores
     */
    async retrieve(
        queryEmbedding: number[],
        query: string,
        options?: Partial<RetrievalOptions>
    ): Promise<RetrievalResult[]> {
        const opts = { ...this.options, ...options };
        const queryIntent = extractQueryIntent(query);

        // Stage 1: Vector similarity search with metadata filtering
        const initialResults = await this.stage1VectorSearch(
            queryEmbedding,
            queryIntent,
            opts.initialK
        );

        if (initialResults.length === 0) {
            return [];
        }

        // Stage 2: Rerank with keyword and metadata weighting
        const rerankedResults = this.stage2Rerank(
            initialResults,
            query,
            queryIntent,
            opts
        );

        // Return top K final results
        return rerankedResults.slice(0, opts.topK);
    }

    /**
     * Stage 1: Vector similarity search
     * 
     * Uses cosine similarity with optional metadata filtering.
     * If query intent suggests a market/type, bias results toward that.
     */
    private async stage1VectorSearch(
        queryEmbedding: number[],
        queryIntent: QueryIntent,
        topK: number
    ): Promise<Array<{ document: string; metadata: DocumentMetadata; score: number }>> {
        // Build metadata filter from query intent
        const metadataFilter: Partial<DocumentMetadata> = {};
        if (queryIntent.market) {
            metadataFilter.market = queryIntent.market;
        }
        if (queryIntent.type) {
            metadataFilter.type = queryIntent.type;
        }

        // If we have a filter, search with it; otherwise search all
        const results = await this.vectorStore.search(
            queryEmbedding,
            topK * 2, // Get more candidates for reranking
            Object.keys(metadataFilter).length > 0 ? metadataFilter : undefined
        );

        // If filtered search returned few results, also search without filter
        if (results.length < topK && (queryIntent.market || queryIntent.type)) {
            const unfilteredResults = await this.vectorStore.search(
                queryEmbedding,
                topK * 2
            );
            
            // Merge and deduplicate by source + chunk_id
            const seen = new Set<string>();
            const merged: typeof results = [];
            
            for (const r of [...results, ...unfilteredResults]) {
                const key = `${r.metadata.source}:${r.metadata.chunk_id}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    merged.push(r);
                }
            }
            
            // Re-sort by score
            merged.sort((a, b) => b.score - a.score);
            return merged.slice(0, topK * 2);
        }

        return results;
    }

    /**
     * Stage 2: Reranking
     * 
     * Combines:
     * - Original cosine similarity score (base)
     * - Keyword match score (TF-based)
     * - Metadata match boost
     */
    private stage2Rerank(
        candidates: Array<{ document: string; metadata: DocumentMetadata; score: number }>,
        query: string,
        queryIntent: QueryIntent,
        options: RetrievalOptions
    ): RetrievalResult[] {
        const queryLower = query.toLowerCase();
        const queryWords = new Set(
            queryLower
                .split(/\s+/)
                .filter(w => w.length > 2)
        );

        const reranked: RetrievalResult[] = candidates.map(candidate => {
            let rerankScore = candidate.score; // Start with vector similarity score

            // Keyword matching boost
            const keywordScore = this.computeKeywordScore(
                candidate.document,
                queryWords,
                queryIntent.keywords
            );
            rerankScore += keywordScore * options.keywordBoost;

            // Metadata matching boost
            const metadataScore = this.computeMetadataScore(
                candidate.metadata,
                queryIntent
            );
            rerankScore += metadataScore * options.metadataBoost;

            return {
                ...candidate,
                rerankScore,
            };
        });

        // Sort by rerank score (descending)
        reranked.sort((a, b) => (b.rerankScore || b.score) - (a.rerankScore || a.score));

        return reranked;
    }

    /**
     * Compute keyword match score between document and query
     * 
     * Simple TF-based scoring: counts occurrences of query keywords
     */
    private computeKeywordScore(
        document: string,
        queryWords: Set<string>,
        intentKeywords: string[]
    ): number {
        const docLower = document.toLowerCase();
        const docWords = docLower.split(/\s+/);
        
        let matches = 0;
        let totalWords = docWords.length;

        // Count matches from query words
        for (const word of queryWords) {
            const count = docWords.filter(w => w.includes(word) || word.includes(w)).length;
            matches += count;
        }

        // Count matches from intent keywords
        for (const keyword of intentKeywords) {
            if (docLower.includes(keyword)) {
                matches += 2; // Intent keywords get higher weight
            }
        }

        // Normalize by document length (avoid bias toward longer docs)
        return totalWords > 0 ? matches / Math.sqrt(totalWords) : 0;
    }

    /**
     * Compute metadata match score
     * 
     * Returns 1.0 if market matches, 0.5 if type matches, 0 otherwise
     */
    private computeMetadataScore(
        metadata: DocumentMetadata,
        queryIntent: QueryIntent
    ): number {
        let score = 0;

        if (queryIntent.market && metadata.market === queryIntent.market) {
            score += 1.0;
        }

        if (queryIntent.type && metadata.type === queryIntent.type) {
            score += 0.5;
        }

        return score;
    }
}
