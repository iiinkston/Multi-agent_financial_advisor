import fs from "fs";
import path from "path";
import { DocumentMetadata } from "./metadataUtils.js";

/**
 * Enhanced Vector Store with Metadata and Persistence
 * 
 * Features:
 * - Stores embeddings with rich metadata
 * - JSON file persistence (loads on init, saves on demand)
 * - Cosine similarity search
 * - Metadata filtering support
 */

export interface VectorStoreItem {
    embedding: number[];
    document: string;
    metadata: DocumentMetadata;
}

interface PersistentStore {
    items: VectorStoreItem[];
    version: string; // For future migrations
}

const STORE_VERSION = "1.0";
const DEFAULT_STORE_PATH = path.join(process.cwd(), ".vectorstore.json");

export default class VectorStore {
    private vectorStore: VectorStoreItem[];
    private storePath: string;
    private dirty: boolean = false; // Track if store needs saving

    constructor(storePath?: string) {
        this.storePath = storePath || DEFAULT_STORE_PATH;
        this.vectorStore = [];
        this.load();
    }

    /**
     * Load vector store from JSON file
     * Creates empty store if file doesn't exist
     */
    private load(): void {
        try {
            if (fs.existsSync(this.storePath)) {
                const data = fs.readFileSync(this.storePath, "utf-8");
                const store: PersistentStore = JSON.parse(data);
                
                // Validate version (for future migrations)
                if (store.version === STORE_VERSION && Array.isArray(store.items)) {
                    this.vectorStore = store.items;
                    console.log(`Loaded ${this.vectorStore.length} vectors from ${this.storePath}`);
                } else {
                    console.warn(`Store version mismatch or invalid format. Starting fresh.`);
                    this.vectorStore = [];
                }
            } else {
                console.log(`Vector store file not found. Starting with empty store.`);
                this.vectorStore = [];
            }
        } catch (error) {
            console.error(`Error loading vector store: ${error}`);
            this.vectorStore = [];
        }
    }

    /**
     * Save vector store to JSON file
     * Only saves if store has been modified (dirty flag)
     */
    async save(): Promise<void> {
        if (!this.dirty) {
            return; // No changes to save
        }

        try {
            const store: PersistentStore = {
                items: this.vectorStore,
                version: STORE_VERSION,
            };

            // Ensure directory exists
            const dir = path.dirname(this.storePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(this.storePath, JSON.stringify(store, null, 2), "utf-8");
            this.dirty = false;
            console.log(`Saved ${this.vectorStore.length} vectors to ${this.storePath}`);
        } catch (error) {
            console.error(`Error saving vector store: ${error}`);
            throw error;
        }
    }

    /**
     * Add one item (embedding + document + metadata) into the store
     */
    async addItem(item: VectorStoreItem): Promise<void> {
        this.vectorStore.push(item);
        this.dirty = true;
    }

    /**
     * Add multiple items at once
     */
    async addItems(items: VectorStoreItem[]): Promise<void> {
        this.vectorStore.push(...items);
        this.dirty = true;
    }

    /**
     * Get total number of items in store
     */
    get size(): number {
        return this.vectorStore.length;
    }

    /**
     * Check if store is empty
     */
    get isEmpty(): boolean {
        return this.vectorStore.length === 0;
    }

    /**
     * Search topK most similar documents given a query embedding
     * Optionally filter by metadata
     */
    async search(
        queryEmbedding: number[],
        topK: number = 3,
        metadataFilter?: Partial<DocumentMetadata>
    ): Promise<Array<{ document: string; metadata: DocumentMetadata; score: number }>> {
        if (this.vectorStore.length === 0) return [];

        // Apply metadata filter if provided
        let candidates = this.vectorStore;
        if (metadataFilter) {
            candidates = this.vectorStore.filter(item => {
                const meta = item.metadata;
                if (metadataFilter.market && meta.market !== metadataFilter.market) {
                    return false;
                }
                if (metadataFilter.type && meta.type !== metadataFilter.type) {
                    return false;
                }
                if (metadataFilter.source && meta.source !== metadataFilter.source) {
                    return false;
                }
                return true;
            });
        }

        if (candidates.length === 0) return [];

        // Compute cosine similarity scores
        const scored = candidates.map(item => ({
            document: item.document,
            metadata: item.metadata,
            score: this.cosineSim(item.embedding, queryEmbedding),
        }));

        // Sort by score (descending) and return topK
        return scored
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    /**
     * Compute cosine similarity between two vectors
     */
    private cosineSim(v1: number[], v2: number[]): number {
        if (v1.length !== v2.length) {
            throw new Error("Vector dimensions do not match");
        }

        const dotProduct = v1.reduce((acc, val, index) => acc + val * v2[index], 0);
        const magnitude1 = Math.sqrt(v1.reduce((acc, val) => acc + val * val, 0));
        const magnitude2 = Math.sqrt(v2.reduce((acc, val) => acc + val * val, 0));

        if (magnitude1 === 0 || magnitude2 === 0) return 0;
        return dotProduct / (magnitude1 * magnitude2);
    }

    /**
     * Clear all items from store (does not delete file)
     */
    clear(): void {
        this.vectorStore = [];
        this.dirty = true;
    }

    /**
     * Get all items (for debugging/inspection)
     */
    getAllItems(): VectorStoreItem[] {
        return [...this.vectorStore];
    }
}
