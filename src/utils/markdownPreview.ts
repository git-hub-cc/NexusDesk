import { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import type { PluggableList } from "unified";

// Permit embedded raster images only on img.src; retain the default URL policy elsewhere.
const embeddedImage = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon);base64,/i;
export function markdownUrlTransform(url: string, key: string, node: { tagName: string }) {
    if (key === "src" && node.tagName === "img" && embeddedImage.test(url)) return url;
    return defaultUrlTransform(url);
}

export const markdownRehypePlugins: PluggableList = [
    rehypeRaw,
    [rehypeSanitize, {
        ...defaultSchema,
        protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), "data"] },
    }],
    rehypeHighlight,
];
