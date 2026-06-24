import OpenAI from "openai";

export type ChartVisionAnalysis = {
    chart_type: "candlestick" | "line" | "bar" | "unknown";
    trend: "bullish" | "bearish" | "sideways" | "unknown";
    patterns: Array<{
        name: string;
        confidence: number;
    }>;
    confidence: number;
    summary: string;
    risk_note: string;
};

const FALLBACK_CHART_VISION: ChartVisionAnalysis = {
    chart_type: "unknown",
    trend: "unknown",
    patterns: [],
    confidence: 0,
    summary: "Unable to parse chart analysis result.",
    risk_note: "Image analysis failed or returned invalid format.",
};

function normalizeChartVision(obj: unknown): ChartVisionAnalysis {
    if (!obj || typeof obj !== "object") return FALLBACK_CHART_VISION;
    const value = obj as Record<string, unknown>;

    const chartType = typeof value.chart_type === "string" ? value.chart_type : "unknown";
    const trend = typeof value.trend === "string" ? value.trend : "unknown";
    const confidence = typeof value.confidence === "number" ? value.confidence : 0;
    const summary = typeof value.summary === "string" ? value.summary : FALLBACK_CHART_VISION.summary;
    const riskNote = typeof value.risk_note === "string" ? value.risk_note : FALLBACK_CHART_VISION.risk_note;
    const patterns = Array.isArray(value.patterns)
        ? value.patterns
            .filter(item => item && typeof item === "object")
            .map(item => {
                const row = item as Record<string, unknown>;
                return {
                    name: typeof row.name === "string" ? row.name : "unknown",
                    confidence: typeof row.confidence === "number" ? row.confidence : 0,
                };
            })
        : [];

    return {
        chart_type: ["candlestick", "line", "bar", "unknown"].includes(chartType)
            ? (chartType as ChartVisionAnalysis["chart_type"])
            : "unknown",
        trend: ["bullish", "bearish", "sideways", "unknown"].includes(trend)
            ? (trend as ChartVisionAnalysis["trend"])
            : "unknown",
        patterns,
        confidence: Number.isFinite(confidence) ? confidence : 0,
        summary,
        risk_note: riskNote,
    };
}

function parseVisionJson(raw: string): ChartVisionAnalysis {
    try {
        return normalizeChartVision(JSON.parse(raw));
    } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return normalizeChartVision(JSON.parse(match[0]));
            } catch {
                return FALLBACK_CHART_VISION;
            }
        }
        return FALLBACK_CHART_VISION;
    }
}

export default class ChartVisionService {
    private readonly client: OpenAI;
    private readonly model: string;

    constructor() {
        this.client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            baseURL: process.env.OPENAI_BASE_URL,
        });
        this.model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";
    }

    async analyzeChartDataUrl(imageDataUrl: string): Promise<ChartVisionAnalysis> {
        if (!process.env.OPENAI_API_KEY) {
            return FALLBACK_CHART_VISION;
        }

        const response = await this.client.responses.create({
            model: this.model,
            input: [
                {
                    role: "system",
                    content: [
                        {
                            type: "input_text",
                            text: "You are a professional financial chart analyst. Analyze only visible chart content. Do not guess ticker/timeframe when unclear. Return strict JSON only.",
                        },
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: `Analyze this chart image and return strict JSON with exactly this schema:
{
  "chart_type": "candlestick | line | bar | unknown",
  "trend": "bullish | bearish | sideways | unknown",
  "patterns": [
    {
      "name": "string",
      "confidence": number
    }
  ],
  "confidence": number,
  "summary": "string",
  "risk_note": "string"
}
Use "unknown" when unclear.`,
                        },
                        {
                            type: "input_image",
                            image_url: imageDataUrl,
                            detail: "auto",
                        },
                    ],
                },
            ],
        });

        const rawText = (response.output_text || "").trim();
        if (!rawText) {
            return FALLBACK_CHART_VISION;
        }
        return parseVisionJson(rawText);
    }
}
