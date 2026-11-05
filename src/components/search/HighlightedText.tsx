import { useMemo } from "react";
import type { SearchOptions } from "@/lib/api";

export function HighlightedText({ text, query, options }: { text: string; query: string; options?: SearchOptions }) {
    const matches = useMemo(() => {
        if (!query.trim()) return [];
        try {
            let source = options?.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (options?.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
            const pattern = new RegExp(source, options?.caseSensitive ? "gu" : "giu");
            return [...text.matchAll(pattern)].filter(match => match[0].length > 0);
        } catch { return []; }
    }, [text, query, options]);
    const parts = [];
    let offset = 0;
    for (const match of matches) {
        parts.push(text.slice(offset, match.index));
        parts.push(<mark key={match.index}>{match[0]}</mark>);
        offset = match.index! + match[0].length;
    }
    parts.push(text.slice(offset));
    return <>{parts}</>;
}
