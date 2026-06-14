import type { MediaItem } from "../types";

export type LiveSourceRequest = {
    channelId: string;
    guildId?: string;
    nsfw?: boolean;
    filter: "all" | "images" | "gifs" | "videos";
};

export type LiveSourceState = {
    items: MediaItem[];
    hasMore: boolean;
};

export function createEmptyLiveSourceState(): LiveSourceState {
    return { items: [], hasMore: true };
}
