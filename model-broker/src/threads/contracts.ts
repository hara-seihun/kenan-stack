export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: "unavailable" | "invalid_request"; message: string } };
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
