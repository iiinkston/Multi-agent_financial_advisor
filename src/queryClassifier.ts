/**
 * Query Intent Classifier
 * 
 * Lightweight rule-based classifier that determines query intent
 * to guide decision-making: when to use RAG, MCP tools, or both.
 * 
 * Decision Flow:
 * 1. Classify query intent based on keywords and patterns
 * 2. Return intent type + confidence score
 * 3. Agent uses this to determine RAG retrieval and tool usage strategy
 */

export enum QueryIntent {
    REALTIME_DATA = "REALTIME_DATA",           // Price, quote, latest movement → MCP tools only
    HISTORICAL_ANALYSIS = "HISTORICAL_ANALYSIS", // Trends, performance, drawdowns → RAG first
    RISK_COMPARISON = "RISK_COMPARISON",       // Risk, volatility, defensive vs aggressive → RAG
    MARKET_STRUCTURE = "MARKET_STRUCTURE",      // Market behavior, macro drivers → RAG
    HYBRID_ANALYSIS = "HYBRID_ANALYSIS",       // Compare markets + current conditions → Both
    UNKNOWN = "UNKNOWN",                        // Fallback → RAG
}

export interface ClassificationResult {
    intent: QueryIntent;
    confidence: number; // 0.0 to 1.0
    reasoning?: string; // Optional explanation for debugging
}

/**
 * Keywords and patterns for each intent category
 */
const INTENT_PATTERNS: Record<QueryIntent, {
    keywords: string[];
    patterns: RegExp[];
    weight: number; // Weight for scoring
}> = {
    [QueryIntent.REALTIME_DATA]: {
        keywords: [
            "price", "quote", "latest", "today", "now", "current", "real-time",
            "realtime", "live", "trading", "bid", "ask", "last trade",
            "what is", "how much", "current price", "latest price",
        ],
        patterns: [
            /current\s+price/i,
            /latest\s+quote/i,
            /real[- ]?time/i,
            /what.*price/i,
            /how much.*cost/i,
            /trading\s+at/i,
        ],
        weight: 1.0,
    },
    [QueryIntent.HISTORICAL_ANALYSIS]: {
        keywords: [
            "trend", "history", "historical", "performance", "drawdown",
            "return", "returns", "over time", "past", "previous",
            "how did", "what happened", "evolution", "development",
            "annual return", "cumulative", "since", "from.*to",
        ],
        patterns: [
            /historical\s+performance/i,
            /price\s+trend/i,
            /over\s+the\s+past/i,
            /since\s+\d{4}/i,
            /from\s+\d{4}\s+to/i,
            /how\s+did.*perform/i,
        ],
        weight: 1.0,
    },
    [QueryIntent.RISK_COMPARISON]: {
        keywords: [
            "risk", "volatility", "volatile", "defensive", "stable",
            "crash", "drawdown", "downside", "safe", "risky",
            "riskier", "safer", "stability", "uncertainty",
            "risk profile", "risk level", "risk assessment",
        ],
        patterns: [
            /risk\s+profile/i,
            /volatility\s+comparison/i,
            /defensive\s+vs/i,
            /riskier\s+than/i,
            /safer\s+than/i,
            /crash\s+risk/i,
        ],
        weight: 1.0,
    },
    [QueryIntent.MARKET_STRUCTURE]: {
        keywords: [
            "market behavior", "market structure", "macro", "macroeconomic",
            "drivers", "factors", "characteristics", "nature of",
            "how does.*market", "market dynamics", "market trends",
            "economic", "fundamental", "structural",
        ],
        patterns: [
            /market\s+behavior/i,
            /market\s+structure/i,
            /macro.*drivers/i,
            /how\s+does.*market\s+work/i,
            /market\s+dynamics/i,
            /structural\s+characteristics/i,
        ],
        weight: 1.0,
    },
    [QueryIntent.HYBRID_ANALYSIS]: {
        keywords: [
            "compare", "versus", "vs", "relative to", "better than",
            "worse than", "compared", "comparison", "relative",
            "which is better", "which performs", "difference between",
            "contrast", "versus", "vs\\.", "vs ",
        ],
        patterns: [
            /compare.*with/i,
            /\bvs\b/i,
            /versus/i,
            /relative\s+to/i,
            /which\s+is\s+better/i,
            /difference\s+between/i,
        ],
        weight: 1.2, // Higher weight for hybrid (often needs both)
    },
    [QueryIntent.UNKNOWN]: {
        keywords: [],
        patterns: [],
        weight: 0.5, // Lower weight for fallback
    },
};

/**
 * Classify query intent based on keywords and patterns
 * 
 * Algorithm:
 * 1. Normalize query (lowercase, trim)
 * 2. Score each intent category based on keyword matches and pattern matches
 * 3. Return highest scoring intent with confidence
 * 
 * @param query - User query string
 * @returns Classification result with intent and confidence
 */
export function classifyQuery(query: string): ClassificationResult {
    if (!query || query.trim().length === 0) {
        return {
            intent: QueryIntent.UNKNOWN,
            confidence: 0.0,
            reasoning: "Empty query",
        };
    }

    const normalizedQuery = query.toLowerCase().trim();
    const scores: Record<QueryIntent, number> = {
        [QueryIntent.REALTIME_DATA]: 0,
        [QueryIntent.HISTORICAL_ANALYSIS]: 0,
        [QueryIntent.RISK_COMPARISON]: 0,
        [QueryIntent.MARKET_STRUCTURE]: 0,
        [QueryIntent.HYBRID_ANALYSIS]: 0,
        [QueryIntent.UNKNOWN]: 0,
    };

    // Score each intent category
    for (const [intent, config] of Object.entries(INTENT_PATTERNS)) {
        if (intent === QueryIntent.UNKNOWN) continue; // Skip unknown

        let score = 0;

        // Keyword matching (exact word boundaries)
        for (const keyword of config.keywords) {
            const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(normalizedQuery)) {
                score += 1.0;
            }
        }

        // Pattern matching (regex patterns)
        for (const pattern of config.patterns) {
            if (pattern.test(normalizedQuery)) {
                score += 2.0; // Patterns are more specific, higher weight
            }
        }

        // Apply category weight
        scores[intent as QueryIntent] = score * config.weight;
    }

    // Find highest scoring intent
    let maxScore = 0;
    let bestIntent = QueryIntent.UNKNOWN;
    let reasoning = "";

    for (const [intent, score] of Object.entries(scores)) {
        if (score > maxScore) {
            maxScore = score;
            bestIntent = intent as QueryIntent;
        }
    }

    // Generate reasoning for debugging
    if (maxScore > 0) {
        const matchedIntents = Object.entries(scores)
            .filter(([_, score]) => score > 0)
            .map(([intent, score]) => `${intent}(${score.toFixed(2)})`)
            .join(", ");
        reasoning = `Matched: ${matchedIntents}`;
    } else {
        reasoning = "No strong matches, using UNKNOWN fallback";
    }

    // Special case: If query mentions specific ticker/symbol and has realtime keywords,
    // boost REALTIME_DATA confidence
    const hasTicker = /\b[A-Z]{1,5}\.[A-Z]{2}\b|\b[A-Z]{1,5}\b/i.test(query);
    const hasRealtimeKeywords = scores[QueryIntent.REALTIME_DATA] > 0;
    if (hasTicker && hasRealtimeKeywords) {
        scores[QueryIntent.REALTIME_DATA] *= 1.5;
        if (scores[QueryIntent.REALTIME_DATA] > maxScore) {
            bestIntent = QueryIntent.REALTIME_DATA;
            maxScore = scores[QueryIntent.REALTIME_DATA];
            reasoning += " (boosted by ticker + realtime keywords)";
        }
    }

    // Special case: If query has comparison keywords but also mentions current/latest,
    // prefer HYBRID_ANALYSIS
    const hasComparison = scores[QueryIntent.HYBRID_ANALYSIS] > 0;
    const hasCurrent = /current|latest|now|today/i.test(normalizedQuery);
    if (hasComparison && hasCurrent) {
        scores[QueryIntent.HYBRID_ANALYSIS] *= 1.3;
        if (scores[QueryIntent.HYBRID_ANALYSIS] > maxScore) {
            bestIntent = QueryIntent.HYBRID_ANALYSIS;
            maxScore = scores[QueryIntent.HYBRID_ANALYSIS];
            reasoning += " (boosted by comparison + current data keywords)";
        }
    }

    // Calculate confidence (normalize to 0-1) after all special cases
    const totalScore = Object.values(scores).reduce((sum, s) => sum + s, 0);
    const confidence = totalScore > 0 ? Math.min(maxScore / (totalScore + 1), 1.0) : 0.0;

    return {
        intent: bestIntent,
        confidence: Math.max(confidence, 0.1), // Minimum 0.1 confidence
        reasoning,
    };
}

/**
 * Determine if query should use RAG retrieval
 */
export function shouldUseRAG(intent: QueryIntent): boolean {
    return [
        QueryIntent.HISTORICAL_ANALYSIS,
        QueryIntent.RISK_COMPARISON,
        QueryIntent.MARKET_STRUCTURE,
        QueryIntent.HYBRID_ANALYSIS,
        QueryIntent.UNKNOWN,
    ].includes(intent);
}

/**
 * Determine if query should prioritize tools
 */
export function shouldPrioritizeTools(intent: QueryIntent): boolean {
    return intent === QueryIntent.REALTIME_DATA;
}

/**
 * Determine if query should discourage tool usage (RAG-focused)
 */
export function shouldDiscourageTools(intent: QueryIntent, query: string): boolean {
    // Check if query mentions specific ticker or date (if so, tools might be needed)
    const hasTicker = /\b[A-Z]{1,5}\.[A-Z]{2}\b|\b[A-Z]{1,5}\b/i.test(query);
    const hasDate = /\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|today|yesterday|last\s+\d+\s+days/i.test(query);

    // If RAG-focused intent and no specific ticker/date, discourage tools
    if ([
        QueryIntent.RISK_COMPARISON,
        QueryIntent.MARKET_STRUCTURE,
        QueryIntent.HISTORICAL_ANALYSIS,
    ].includes(intent) && !hasTicker && !hasDate) {
        return true;
    }

    return false;
}
