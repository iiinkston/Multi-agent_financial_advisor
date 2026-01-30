/**
 * Metadata Utilities
 * 
 * Extracts and infers metadata from documents and queries for domain-aware retrieval.
 */

export type Market = "US" | "UK" | "SG" | "HK" | "CN";
export type DocumentType = "market_summary" | "risk_analysis" | "macro" | "general";

export interface DocumentMetadata {
    source: string;
    chunk_id: number;
    market?: Market;
    type?: DocumentType;
}

/**
 * Market detection patterns
 */
const MARKET_PATTERNS: Record<Market, RegExp[]> = {
    US: [
        /US\s+market/i,
        /S&P\s*500/i,
        /NASDAQ/i,
        /NYSE/i,
        /Dow\s+Jones/i,
        /American\s+stock/i,
        /\.US\b/i,
    ],
    UK: [
        /UK\s+market/i,
        /FTSE/i,
        /London\s+Stock\s+Exchange/i,
        /LSE/i,
        /British\s+market/i,
        /\.L\b/i,
    ],
    SG: [
        /Singapore\s+market/i,
        /STI/i,
        /SGX/i,
        /Singapore\s+Stock/i,
        /\.SI\b/i,
    ],
    HK: [
        /Hong\s+Kong\s+market/i,
        /HK\s+market/i,
        /Hang\s+Seng/i,
        /HKEX/i,
        /\.HK\b/i,
    ],
    CN: [
        /China\s+market/i,
        /Chinese\s+market/i,
        /A-share/i,
        /Shanghai/i,
        /Shenzhen/i,
        /\.SH\b/i,
        /\.SZ\b/i,
    ],
};

/**
 * Document type detection patterns
 */
const TYPE_PATTERNS: Record<DocumentType, RegExp[]> = {
    market_summary: [
        /market\s+summary/i,
        /market\s+overview/i,
        /market\s+analysis/i,
        /price\s+trend/i,
        /trading\s+data/i,
    ],
    risk_analysis: [
        /risk\s+analysis/i,
        /risk\s+assessment/i,
        /volatility/i,
        /risk\s+factors/i,
        /downside\s+risk/i,
    ],
    macro: [
        /macro\s+economic/i,
        /macroeconomic/i,
        /economic\s+indicator/i,
        /GDP/i,
        /inflation/i,
        /interest\s+rate/i,
    ],
    general: [], // Default fallback
};

/**
 * Detects market from text content
 */
export function detectMarket(text: string, source?: string): Market | undefined {
    const searchText = `${text} ${source || ""}`.toLowerCase();

    for (const [market, patterns] of Object.entries(MARKET_PATTERNS)) {
        for (const pattern of patterns) {
            if (pattern.test(searchText)) {
                return market as Market;
            }
        }
    }

    // Fallback: check filename patterns
    if (source) {
        const lowerSource = source.toLowerCase();
        if (lowerSource.includes("us") || lowerSource.includes("sp500")) return "US";
        if (lowerSource.includes("uk") || lowerSource.includes("ftse")) return "UK";
        if (lowerSource.includes("sg") || lowerSource.includes("singapore")) return "SG";
        if (lowerSource.includes("hk") || lowerSource.includes("hong")) return "HK";
        if (lowerSource.includes("cn") || lowerSource.includes("china")) return "CN";
    }

    return undefined;
}

/**
 * Detects document type from text content
 */
export function detectDocumentType(text: string): DocumentType {
    const searchText = text.toLowerCase();

    for (const [type, patterns] of Object.entries(TYPE_PATTERNS)) {
        if (type === "general") continue; // Skip default

        for (const pattern of patterns) {
            if (pattern.test(searchText)) {
                return type as DocumentType;
            }
        }
    }

    return "general";
}

/**
 * Extracts metadata from a document chunk
 */
export function extractMetadata(
    text: string,
    source: string,
    chunkId: number
): DocumentMetadata {
    return {
        source,
        chunk_id: chunkId,
        market: detectMarket(text, source),
        type: detectDocumentType(text),
    };
}

/**
 * Extracts query intent for domain-aware filtering
 */
export interface QueryIntent {
    market?: Market;
    type?: DocumentType;
    keywords: string[];
}

export function extractQueryIntent(query: string): QueryIntent {
    const lowerQuery = query.toLowerCase();
    const keywords: string[] = [];

    // Extract market intent
    let market: Market | undefined;
    for (const [m, patterns] of Object.entries(MARKET_PATTERNS)) {
        for (const pattern of patterns) {
            if (pattern.test(lowerQuery)) {
                market = m as Market;
                break;
            }
        }
        if (market) break;
    }

    // Extract type intent
    let type: DocumentType | undefined;
    for (const [t, patterns] of Object.entries(TYPE_PATTERNS)) {
        if (t === "general") continue;
        for (const pattern of patterns) {
            if (pattern.test(lowerQuery)) {
                type = t as DocumentType;
                break;
            }
        }
        if (type) break;
    }

    // Extract important keywords (simple heuristic: words > 3 chars, not common stop words)
    const stopWords = new Set([
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
        "of", "with", "by", "from", "as", "is", "are", "was", "were", "be",
        "been", "have", "has", "had", "do", "does", "did", "will", "would",
        "should", "could", "may", "might", "can", "this", "that", "these",
        "those", "what", "which", "who", "when", "where", "why", "how",
    ]);

    const words = lowerQuery
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w))
        .slice(0, 10); // Limit to top 10 keywords

    keywords.push(...words);

    return { market, type, keywords };
}
