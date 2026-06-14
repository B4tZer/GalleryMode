import { RestAPI } from "@webpack/common";
import { MessageStore } from "@webpack/common";

import type { MediaItem, VaultItem } from "./types";

const VIDEO_EXT_RE = /\.(mp4|webm|mov)($|\?)/i;

function normalizeUrl(url: string) {
    return url.startsWith("//") ? `https:${url}` : url;
}

export function sanitizeVaultKey(value: string) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function makeVaultItemId(channelId: string, messageId: string, mediaKey: string) {
    return `${channelId}_${messageId}_${sanitizeVaultKey(mediaKey)}`;
}

function extractMediaFromMessage(msg: any): Array<{ key: string; url: string; type: string; width: number; height: number; }> {
    const items: Array<{ key: string; url: string; type: string; width: number; height: number; }> = [];
    const seen = new Set<string>();

    const add = (url: string, type: string, width = 0, height = 0) => {
        if (!url) return;
        const normalized = normalizeUrl(url);
        const key = `${msg.id}:${normalized}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ key, url: normalized, type, width, height });
    };

    msg.attachments?.forEach((a: any) => {
        if (a.url) add(a.url, a.content_type?.startsWith("video/") ? "video" : "image", a.width ?? 0, a.height ?? 0);
    });

    msg.embeds?.forEach((e: any) => {
        if (e.image?.url) add(e.image.url, "image", e.image.width ?? 0, e.image.height ?? 0);
        if (e.video?.url) add(e.video.url, VIDEO_EXT_RE.test(e.video.url) ? "video" : "image", e.video.width ?? 0, e.video.height ?? 0);
    });

    return items;
}

async function fetchMessage(channelId: string, messageId: string) {
    const cached = MessageStore.getMessages(channelId)?.get?.(messageId);
    if (cached) return cached;

    const response = await RestAPI.get({
        url: `/channels/${channelId}/messages`,
        query: { around: messageId, limit: 50 },
    });

    const messages = response.body ?? [];
    return messages.find((m: any) => m.id === messageId) ?? null;
}

export async function hydrateVaultItems(items: VaultItem[]): Promise<MediaItem[]> {
    const hydrated: MediaItem[] = [];

    for (const item of items) {
        const message = await fetchMessage(item.channelId, item.messageId);
        if (!message) continue;

        const media = extractMediaFromMessage(message);
        const match = media.find(entry => makeVaultItemId(item.channelId, item.messageId, entry.key) === item.id);
        if (!match) continue;

        hydrated.push({
            ...item,
            url: match.url,
        });
    }

    return hydrated;
}
