export interface VaultItem {
    /** Composite key: `${channelId}_${messageId}_${attachmentIndex}` */
    id: string;
    channelId: string;
    messageId: string;
    width: number;
    height: number;
    /** MIME type to determine <img> vs <video> rendering */
    type: string;
    /** Unix timestamp for sorting */
    savedAt: number;
}

export interface MediaItem extends VaultItem {
    /** The hydrated proxy_url. This is NEVER saved to the DB. */
    url: string;
}

export type MediaSuiteMode = "channel" | "vault";
