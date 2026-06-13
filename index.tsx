/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { copyToClipboard } from "@utils/clipboard";
import definePlugin, { OptionType } from "@utils/types";
import { saveFile } from "@utils/web";
import { findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import {
    Menu,
    Modal,
    openModal,
    React,
    RestAPI,
    showToast,
    Text,
    Toasts,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "@webpack/common";

import style from "./style.css?managed";

const log = new Logger("GalleryMode");

enum FavouriteItemFormat { NONE = 0, IMAGE = 1, VIDEO = 2 }
interface FavoriteButtonProps {
    format: FavouriteItemFormat;
    src: string;
    url: string;
    width: number;
    height: number;
    className?: string;
}

type MediaItem = {
    key: string;
    url: string;
    proxyUrl?: string;
    sourceUrl: string;
    isGif: boolean;
    isVideo: boolean;
    messageId: string;
    knownWidth?: number;
    knownHeight?: number;
};

type FilterType = "all" | "images" | "gifs" | "videos";

type SearchTag = "image" | "video" | "embed";

type SubSearchState = {
    tag: SearchTag;
    offset: number;
    hasMore: boolean;
};

const JumpAction = findByPropsLazy("jumpToMessage");
const FavoriteButton = findComponentByCodeLazy<FavoriteButtonProps>("#{intl::GIF_TOOLTIP_ADD_TO_FAVORITES}");
const VIDEO_EXT_RE = /\.(mp4|webm|mov)($|\?)/i;

const Quality = {
    High: 1,
    Reasonable: 2,
    Low: 3,
    Horrible: 4,
} as const;

const qualities = [
    { giphy: "giphy", tenor: "Ax", video: "Po" },
    { giphy: "480w", tenor: "A5", video: "P3" },
    { giphy: "200", tenor: "A1", video: "P2" },
    { giphy: "100", tenor: "A2", video: "P4" },
];

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const mediaTenorRegex = /^https:\/\/(?:media\d?|c)\.tenor\.com(?:\/m)?\/(?<id>.+?)(?<quality>\w{2})\/(?<name>[^/]+)\.(?<ext>gif|webp|mp4|webm)$/i;
const giphyLinkRegex = /^https:\/\/media\d?\.giphy\.com\/media\/.*?\/(?<code>.*?)\/giphy/i;

const settings = definePluginSettings({
    gridColumns: {
        type: OptionType.NUMBER,
        description: "Number of columns (0 = adaptive based on window size)",
        default: 4,
    },
    gifQuality: {
        type: OptionType.SELECT,
        description: "GIF quality level",
        options: [
            { label: "High", value: Quality.High, default: true },
            { label: "Reasonable", value: Quality.Reasonable },
            { label: "Low", value: Quality.Low },
            { label: "Horrible", value: Quality.Horrible },
        ],
    },
    cacheTtlMinutes: {
        type: OptionType.NUMBER,
        description: "Minutes to remember gallery position after closing (0 = disabled)",
        default: 30,
    },
    layoutMode: {
        type: OptionType.SELECT,
        description: "Gallery layout style",
        options: [
            { label: "Square Grid", value: "grid", default: true },
            { label: "Masonry", value: "masonry" },
        ],
    },
});

type GalleryCache = {
    mediaItems: MediaItem[];
    subSearches: SubSearchState[];
    mediaSizes: Record<string, { width: number; height: number; }>;
    activeFilter: FilterType;
    scrollTop: number;
    timestamp: number;
};

const channelCacheMap = new Map<string, GalleryCache>();

// fixed some media not showing up in some cases
function getSubSearches(filter: FilterType): SubSearchState[] {
    const tags: SearchTag[] = filter === "all"
        ? ["image", "video", "embed"]
        : filter === "videos"
            ? ["video"]
            : ["image", "embed"];

    return tags.map(tag => ({ tag, offset: 0, hasMore: true }));
}

function normalizeUrl(url: string) {
    return url.startsWith("//") ? `https:${url}` : url;
}

function parseCdnDimensions(url: string): { width: number; height: number; } | null {
    try {
        const parsed = new URL(url);
        const w = parseInt(parsed.searchParams.get("width") ?? "", 10);
        const h = parseInt(parsed.searchParams.get("height") ?? "", 10);
        if (w > 0 && h > 0) return { width: w, height: h };
    } catch {}
    return null;
}

async function copyMediaToClipboard(url: string, isVideo: boolean): Promise<boolean> {
    if (isVideo) {
        await copyToClipboard(url);
        return false;
    }
    try {
        const res = await fetch(url);
        const blob = await res.blob();
        const item = new ClipboardItem({ [blob.type]: blob });
        await navigator.clipboard.write([item]);
        return true;
    } catch {
        await copyToClipboard(url);
        return false;
    }
}

function getAspectRatio(item: MediaItem, mediaSizes: Record<string, { width: number; height: number; }>): string {
    const w = item.knownWidth ?? mediaSizes[item.key]?.width;
    const h = item.knownHeight ?? mediaSizes[item.key]?.height;
    return w && h ? `${w} / ${h}` : "1 / 1";
}

function getGifFavoriteUrl(item: Pick<MediaItem, "url" | "sourceUrl">) {
    return normalizeUrl(item.sourceUrl || item.url);
}

function getQualityUrl(url: string, qualityLevel: number) {
    const q = qualities[qualityLevel - 1] ?? qualities[0];
    const cleanUrl = normalizeUrl(url);

    const tenorMatch = cleanUrl.match(mediaTenorRegex);
    if (tenorMatch) {
        const { id, name, ext } = tenorMatch.groups!;
        const isVideo = ext === "mp4" || ext === "webm";
        return `https://media.tenor.com/${id}${isVideo ? q.video : q.tenor}/${name}.${isVideo ? ext : "webp"}`;
    }

    const giphyMatch = cleanUrl.match(giphyLinkRegex);
    if (giphyMatch) {
        const { code } = giphyMatch.groups!;
        if (VIDEO_EXT_RE.test(cleanUrl)) return cleanUrl;
        return `https://i.giphy.com/media/${code}/${q.giphy}.webp`;
    }

    try {
        const parsed = new URL(cleanUrl);
        if (parsed.hostname === "cdn.discordapp.com" || parsed.hostname === "media.discordapp.net") {
            parsed.searchParams.set("format", "webp");
            parsed.searchParams.set("animated", "true");
            return parsed.toString();
        }
    } catch {}

    return cleanUrl;
}

function extractMediaFromMessage(msg: any): MediaItem[] {
    const items: MediaItem[] = [];
    const seenKeys = new Set<string>();
    const isGiphyEmbed = (embed: any) => embed?.url?.includes("giphy") || embed?.provider?.name === "Giphy";

    const addMedia = (url: string, forceGif = false, sourceUrl?: string, proxyUrl?: string, w?: number, h?: number) => {
        if (!url) return;
        const normalizedUrl = normalizeUrl(url);
        const key = `${msg.id}:${normalizedUrl}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        const normalizedSourceUrl = normalizeUrl(sourceUrl || url);
        const normalizedProxyUrl = proxyUrl ? normalizeUrl(proxyUrl) : undefined;
        const lowerUrl = url.toLowerCase();
        const isVideoExt = VIDEO_EXT_RE.test(lowerUrl);
        const isGifExt = forceGif || !!lowerUrl.match(/\.(gif)($|\?)/i) || url.includes("tenor.com");
        const cdnDims = (!w || !h) ? parseCdnDimensions(normalizedProxyUrl ?? normalizedUrl) : null;
        items.push({
            key,
            url: normalizedUrl,
            proxyUrl: normalizedProxyUrl,
            sourceUrl: normalizedSourceUrl,
            isGif: isGifExt,
            isVideo: isVideoExt && !isGifExt,
            messageId: msg.id,
            knownWidth: w || cdnDims?.width,
            knownHeight: h || cdnDims?.height,
        });
    };

    msg.attachments?.forEach((a: any) => {
        if (a.content_type?.startsWith("image/") || a.content_type?.startsWith("video/")) {
            addMedia(a.url || a.proxy_url, false, undefined, a.proxy_url, a.width, a.height);
        }
    });

    msg.embeds?.forEach((e: any) => {
        if (e.type === "image" && e.image?.url) {
            addMedia(e.image.url, isGiphyEmbed(e), undefined, e.image.proxyURL, e.image.width, e.image.height);
        } else if (e.type === "video" && e.video?.url) {
            addMedia(e.video.url, e.provider?.name === "Tenor" || e.url?.includes("tenor") || isGiphyEmbed(e), e.url || e.video.url, e.video.proxyURL, e.video.width, e.video.height);
        } else if (e.type === "gifv" && e.video?.url) {
            addMedia(e.video.url, true, e.url || e.video.url, e.video.proxyURL, e.video.width, e.video.height);
        }
    });

    return items;
}

function GalleryModal({ channel, modalProps }: { channel: any; modalProps: any }) {
    const gifQuality = settings.store.gifQuality ?? Quality.High;
    const cacheTtlMinutes = settings.store.cacheTtlMinutes ?? 30;
    const cacheTtlMs = cacheTtlMinutes > 0 ? cacheTtlMinutes * 60_000 : 0;

    const saved = cacheTtlMs > 0 ? channelCacheMap.get(channel.id) : null;
    if (saved && Date.now() - saved.timestamp >= cacheTtlMs) {
        channelCacheMap.delete(channel.id);
    }
    const cachedState = saved && Date.now() - saved.timestamp < cacheTtlMs ? saved : null;

    const [isFetching, setIsFetching] = useState(false);
    const [activeFilter, setActiveFilter] = useState<FilterType>(cachedState?.activeFilter ?? "all");
    const [mediaItems, setMediaItems] = useState<MediaItem[]>(cachedState?.mediaItems ?? []);
    const [subSearches, setSubSearches] = useState<SubSearchState[]>(cachedState?.subSearches ?? getSubSearches(cachedState?.activeFilter ?? "all"));
    const [mediaSizes, setMediaSizes] = useState<Record<string, { width: number; height: number; }>>(cachedState?.mediaSizes ?? {});
    const [layoutMode, setLayoutMode] = useState<"grid" | "masonry">((settings.store.layoutMode as "grid" | "masonry") ?? "grid");
    const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
    const [columnSetting, setColumnSetting] = useState(settings.store.gridColumns ?? 4);
    const [isIndexing, setIsIndexing] = useState(false);
    const [containerWidth, setContainerWidth] = useState(0);

    const gridRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const mountedRef = useRef(true);
    const fetchingRef = useRef(false);
    const scrollTopRef = useRef(0);
    const indexingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestSeqRef = useRef(0);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const fetchFnRef = useRef<((isResetting?: boolean, targetFilter?: FilterType) => Promise<void>) | null>(null);
    const subSearchesRef = useRef(subSearches);

    const stateRef = useRef<GalleryCache>({
        mediaItems: [],
        subSearches: getSubSearches("all"),
        mediaSizes: {},
        activeFilter: "all",
        scrollTop: 0,
        timestamp: 0,
    });

    useLayoutEffect(() => {
        stateRef.current = {
            mediaItems,
            subSearches,
            mediaSizes,
            activeFilter,
            scrollTop: scrollTopRef.current,
            timestamp: Date.now(),
        };
    }, [mediaItems, subSearches, mediaSizes, activeFilter]);

    useEffect(() => {
        subSearchesRef.current = subSearches;
    }, [subSearches]);

    useEffect(() => {
        return () => {
            mountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        return () => {
            if (indexingTimeoutRef.current) clearTimeout(indexingTimeoutRef.current);
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        };
    }, []);

    useEffect(() => {
        if (cacheTtlMs <= 0) return;
        return () => {
            if (stateRef.current.mediaItems.length > 0) {
                channelCacheMap.delete(channel.id);
                channelCacheMap.set(channel.id, {
                    ...stateRef.current,
                    scrollTop: scrollTopRef.current,
                    timestamp: Date.now(),
                });
            }
            if (channelCacheMap.size > 50) {
                const oldestKey = channelCacheMap.keys().next().value;
                if (oldestKey) channelCacheMap.delete(oldestKey);
            }
        };
    }, [cacheTtlMs, channel.id]);

    useEffect(() => {
        if (observerRef.current) return;
        observerRef.current = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const media = entry.target as HTMLImageElement | HTMLVideoElement;
                const { src } = media.dataset;
                if (src) {
                    media.src = src;
                    if (media.tagName === "VIDEO") {
                        (media as HTMLVideoElement).load();
                    }
                    delete media.dataset.src;
                    delete media.dataset.vcGalleryLazy;
                }
                observerRef.current?.unobserve(media);
            }
        }, { root: scrollRef.current, rootMargin: "0px 0px 800px 0px" });

        const pending = scrollRef.current?.querySelectorAll<HTMLElement>("[data-vc-gallery-lazy]");
        pending?.forEach(media => observerRef.current?.observe(media));

        return () => {
            observerRef.current?.disconnect();
            observerRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!gridRef.current) return;
        const ro = new ResizeObserver(entries => {
            const width = entries[0].contentRect.width;
            requestAnimationFrame(() => {
                setContainerWidth(prev => prev === width ? prev : width);
            });
        });
        ro.observe(gridRef.current);
        return () => ro.disconnect();
    }, []);

    const effectiveColumns = useMemo(() => {
        if (columnSetting > 0) return columnSetting;
        if (!containerWidth) return 4;
        return Math.max(2, Math.floor((containerWidth + 12) / (200 + 12)));
    }, [columnSetting, containerWidth]);

    const hasMore = subSearches.some(search => search.hasMore);

    const setFetching = (value: boolean) => {
        fetchingRef.current = value;
        setIsFetching(value);
    };

    const setSearches = (next: SubSearchState[]) => {
        subSearchesRef.current = next;
        setSubSearches(next);
    };

    const rememberSize = (key: string, width: number, height: number) => {
        if (!width || !height) return;
        setMediaSizes(prev => {
            const current = prev[key];
            if (current?.width === width && current?.height === height) return prev;
            return { ...prev, [key]: { width, height } };
        });
    };

    const resetGalleryState = (filter = activeFilter) => {
        setMediaItems([]);
        setMediaSizes({});
        setSearches(getSubSearches(filter));
        scrollTopRef.current = 0;
    };

    const jumpToMessage = (messageId: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!JumpAction?.jumpToMessage) {
            log.error("jumpToMessage module not found");
            showToast("Unable to jump to message", Toasts.Type.FAILURE);
            return;
        }
        try {
            JumpAction.jumpToMessage({
                channelId: channel.id,
                messageId,
                flash: true,
                jumpType: "INSTANT",
            });
            modalProps.onClose();
        } catch (error) {
            log.error("jumpToMessage failed", error);
            showToast("Failed to jump to message", Toasts.Type.FAILURE);
        }
    };

    const fetchOlderMessages = async (isResetting = false, targetFilter = activeFilter) => {
        const currentSearches = isResetting ? getSubSearches(targetFilter) : subSearchesRef.current;
        if (fetchingRef.current || !currentSearches.some(search => search.hasMore)) return;
        setFetching(true);
        const requestSeq = ++requestSeqRef.current;
        if (indexingTimeoutRef.current) {
            clearTimeout(indexingTimeoutRef.current);
            indexingTimeoutRef.current = null;
        }

        try {
            const isGuild = !!channel.guild_id;
            const searchUrl = isGuild
                ? `/guilds/${channel.guild_id}/messages/search`
                : `/channels/${channel.id}/messages/search`;

            setIsIndexing(false);

            const nextSearches = currentSearches.map(search => ({ ...search }));
            const extractedMedia: MediaItem[] = [];

            for (const search of currentSearches.filter(s => s.hasMore)) {
                let retries = 0;
                let success = false;

                while (retries < 3 && !success) {
                    if (!mountedRef.current || requestSeq !== requestSeqRef.current) return;

                    try {
                        const response = await RestAPI.get({
                            url: searchUrl,
                            query: {
                                has: search.tag,
                                offset: search.offset,
                                ...(isGuild ? { channel_id: channel.id } : {}),
                                ...((channel.nsfw || channel.isNSFW?.()) ? { include_nsfw: true } : {}),
                            },
                        });

                        if (!mountedRef.current || requestSeq !== requestSeqRef.current) return;

                        if (response.status === 202) {
                            setIsIndexing(true);
                            indexingTimeoutRef.current = setTimeout(() => {
                                if (mountedRef.current) fetchFnRef.current?.(isResetting, targetFilter);
                            }, 3000);
                            return;
                        }

                        const next = nextSearches.find(s => s.tag === search.tag);
                        const foundMessages = response.body?.messages?.map((hitGroup: any[]) => hitGroup?.[0]).filter(Boolean) ?? [];
                        extractedMedia.push(...foundMessages.flatMap((msg: any) => extractMediaFromMessage(msg)));

                        if (next) {
                            const fetchedCount = foundMessages.length;
                            next.offset += fetchedCount;
                            if (fetchedCount < 25) next.hasMore = false;
                        }

                        success = true;
                    } catch (error: any) {
                        if (error.status === 429) {
                            const retryAfterSec = Number(error.body?.retry_after ?? 5);
                            const waitSec = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 5;
                            showToast(`Rate limited. Waiting ${Math.ceil(waitSec)}s...`, Toasts.Type.WARNING);
                            await sleep(waitSec * 1000);
                            retries++;
                            if (retries >= 3) {
                                showToast(`Skipped loading ${search.tag}s after 3 timeouts. Try again later.`, Toasts.Type.FAILURE);
                            }
                            continue;
                        }

                        log.error(`Search API failed for tag: ${search.tag}`, error);
                        break;
                    }
                }
            }

            if (!mountedRef.current || requestSeq !== requestSeqRef.current) return;

            setMediaItems(prev => {
                const seen = new Set(prev.map(item => item.key));
                const newItems = extractedMedia.filter(item => !seen.has(item.key));
                return isResetting ? extractedMedia : [...prev, ...newItems];
            });

            setSearches(nextSearches);
        } catch (error) {
            log.error("Search API failed", error);
        } finally {
            if (mountedRef.current) setFetching(false);
        }
    };

    useEffect(() => {
        fetchFnRef.current = fetchOlderMessages;
    });

    const initialFetchDone = useRef(mediaItems.length > 0);

    useEffect(() => {
        if (initialFetchDone.current) return;
        initialFetchDone.current = true;
        fetchOlderMessages();
    }, []);

    useEffect(() => {
        if (cachedState?.scrollTop == null || !scrollRef.current) return;
        const el = scrollRef.current;
        let raf1 = 0;
        let raf2 = 0;
        raf1 = requestAnimationFrame(() => {
            raf2 = requestAnimationFrame(() => {
                el.scrollTop = cachedState.scrollTop!;
            });
        });
        return () => {
            cancelAnimationFrame(raf1);
            cancelAnimationFrame(raf2);
        };
    }, []);

    const handleScroll = (e: any) => {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        scrollTopRef.current = scrollTop;
        if (scrollHeight - scrollTop <= clientHeight + 800) fetchOlderMessages();
    };

    const handleFilterChange = (type: FilterType) => {
        if (activeFilter === type) return;
        requestSeqRef.current++;
        if (indexingTimeoutRef.current) {
            clearTimeout(indexingTimeoutRef.current);
            indexingTimeoutRef.current = null;
        }
        channelCacheMap.delete(channel.id);
        setActiveFilter(type);
        resetGalleryState(type);
        fetchOlderMessages(true, type);
    };

    const getFavoriteButtonProps = (item: MediaItem) => {
        if (!item.isGif) return null;
        const size = mediaSizes[item.key];
        if (!size) return null;
        const isVideoGif = VIDEO_EXT_RE.test(item.url);
        return {
            format: isVideoGif ? FavouriteItemFormat.VIDEO : FavouriteItemFormat.IMAGE,
            src: item.proxyUrl || item.url,
            url: getGifFavoriteUrl(item),
            width: size.width,
            height: size.height,
        } satisfies FavoriteButtonProps;
    };

    const displayedMedia = useMemo(() => mediaItems.filter(item => {
        if (activeFilter === "videos") return item.isVideo;
        if (activeFilter === "gifs") return item.isGif;
        if (activeFilter === "images") return !item.isVideo && !item.isGif;
        return true;
    }), [mediaItems, activeFilter]);

    const handleCopy = async (item: MediaItem, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const url = item.proxyUrl || item.url;
        const copiedImage = await copyMediaToClipboard(url, item.isVideo);
        setCopyFeedback(copiedImage ? "Image copied!" : "URL copied!");
        if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = setTimeout(() => setCopyFeedback(null), 2000);
    };

    const handleDownload = async (item: MediaItem, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const url = item.proxyUrl || item.url;
        try {
            const res = await fetch(url);
            const blob = await res.blob();
            const ext = blob.type.split("/")[1] || url.split(".").pop()?.split("?")[0] || "bin";
            saveFile(new File([blob], `${item.messageId}.${ext}`, { type: blob.type }));
        } catch {
            window.open(url, "_blank");
        }
    };

    return (
        <Modal {...modalProps} size="dynamic" title={`Gallery: ${channel.name}`}>
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
                <FilterButton label="All Media" type="all" activeFilter={activeFilter} onFilterChange={handleFilterChange} />
                <FilterButton label="Images" type="images" activeFilter={activeFilter} onFilterChange={handleFilterChange} />
                <FilterButton label="GIFs" type="gifs" activeFilter={activeFilter} onFilterChange={handleFilterChange} />
                <FilterButton label="Videos" type="videos" activeFilter={activeFilter} onFilterChange={handleFilterChange} />
                <div style={{ marginLeft: "auto", display: "flex", gap: "6px", alignItems: "center" }}>
                    <input
                        type="range"
                        min={0}
                        max={8}
                        step={1}
                        value={columnSetting}
                        onChange={e => {
                            const val = Number(e.target.value);
                            settings.store.gridColumns = val;
                            setColumnSetting(val);
                        }}
                        className="vc-gallery-col-slider"
                        title="Columns (0 = adaptive)"
                    />
                    <span className="vc-gallery-col-label">{columnSetting === 0 ? "Auto" : columnSetting}</span>
                    <button
                        onClick={() => {
                            settings.store.layoutMode = "grid";
                            setLayoutMode("grid");
                        }}
                        className={`vc-gallery-filter-btn vc-gallery-layout-btn ${layoutMode === "grid" ? "vc-gallery-filter-btn-active" : ""}`}
                        title="Square grid"
                    >⊞</button>
                    <button
                        onClick={() => {
                            settings.store.layoutMode = "masonry";
                            setLayoutMode("masonry");
                        }}
                        className={`vc-gallery-filter-btn vc-gallery-layout-btn ${layoutMode === "masonry" ? "vc-gallery-filter-btn-active" : ""}`}
                        title="Masonry"
                    >⬚</button>
                </div>
            </div>

            {isIndexing && (
                <div style={{
                    backgroundColor: "var(--background-message-automod)",
                    color: "var(--text-normal)",
                    padding: "8px 12px",
                    borderRadius: "8px",
                    marginBottom: "12px",
                    fontSize: "14px",
                    fontWeight: 500,
                    borderLeft: "4px solid var(--info-warning-foreground)",
                }}>
                    Discord is currently indexing this channel's media. This may take a moment...
                </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
                <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>
                    {displayedMedia.length} items loaded{isFetching ? " (loading...)" : ""}
                </div>
                {copyFeedback && (
                    <div style={{ color: "var(--text-positive)", fontSize: "12px", fontWeight: 600 }}>
                        {copyFeedback}
                    </div>
                )}
            </div>

            <div ref={scrollRef} style={{ maxHeight: "60vh", overflowY: "auto" }} onScroll={handleScroll}>
                <div
                    ref={gridRef}
                    className={layoutMode === "masonry" ? "vc-gallery-masonry" : "vc-gallery-grid"}
                    style={({ "--vc-gallery-column-count": effectiveColumns, gridTemplateColumns: layoutMode === "grid" ? `repeat(${effectiveColumns}, minmax(200px, 1fr))` : undefined } as any)}
                >
                    {displayedMedia.map(item => {
                        const favoriteProps = getFavoriteButtonProps(item);
                        const isVideoContent = item.isVideo || (item.isGif && VIDEO_EXT_RE.test(item.url));
                        const aspectRatio = getAspectRatio(item, mediaSizes);
                        const cardStyle = layoutMode === "masonry" ? { aspectRatio } : {};

                        return (
                            <div key={item.key} className={`vc-gallery-card ${layoutMode === "masonry" ? "vc-gallery-card-masonry" : ""}`} style={cardStyle}>
                                {favoriteProps ? <div className="vc-gallery-fav-btn-wrap"><FavoriteButton {...favoriteProps} className="vc-gallery-fav-btn" /></div> : null}
                                {isVideoContent ? (
                                    <video
                                        data-src={getQualityUrl(item.url, gifQuality)}
                                        data-vc-gallery-lazy="1"
                                        controls={!item.isGif}
                                        autoPlay={item.isGif}
                                        muted
                                        loop
                                        className="vc-gallery-media"
                                        ref={el => {
                                            if (!el || el.src) return;
                                            if (observerRef.current) {
                                                observerRef.current.observe(el);
                                            } else {
                                                el.dataset.vcGalleryLazy = "1";
                                            }
                                        }}
                                        onLoadedMetadata={e => rememberSize(item.key, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                                    />
                                ) : (
                                    <a href={item.url} target="_blank" rel="noreferrer" style={{ display: "block", width: "100%", height: "100%" }}>
                                        <img
                                            data-src={getQualityUrl(item.url, gifQuality)}
                                            className="vc-gallery-media"
                                            alt=""
                                            ref={el => {
                                                if (!el || el.src) return;
                                                if (observerRef.current) {
                                                    observerRef.current.observe(el);
                                                } else {
                                                    el.dataset.vcGalleryLazy = "1";
                                                }
                                            }}
                                            onLoad={e => rememberSize(item.key, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
                                            onError={e => {
                                                const card = e.currentTarget.closest(".vc-gallery-card") as HTMLElement;
                                                if (card) card.style.display = "none";
                                            }}
                                        />
                                    </a>
                                )}
                                <div className="vc-gallery-card-actions">
                                    <div className="vc-gallery-action-btn" title="Copy" onClick={e => handleCopy(item, e)}>⎘</div>
                                    <div className="vc-gallery-action-btn" title="Download" onClick={e => handleDownload(item, e)}>↓</div>
                                    <div className="vc-gallery-action-btn" title="Jump to message" onClick={e => jumpToMessage(item.messageId, e)}>↗</div>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div style={{ display: "flex", justifyContent: "center", margin: "30px 0 10px" }}>
                    {hasMore ? (
                        <button
                            onClick={() => fetchOlderMessages()}
                            disabled={isFetching}
                            style={{
                                padding: "12px 24px",
                                borderRadius: "8px",
                                border: "none",
                                cursor: isFetching ? "not-allowed" : "pointer",
                                backgroundColor: isFetching ? "var(--background-modifier-active)" : "var(--brand-experiment)",
                                color: "white",
                                fontWeight: "bold",
                                fontSize: "16px",
                            }}
                        >
                            {isFetching ? "Loading..." : "Load Older Messages"}
                        </button>
                    ) : (
                        <Text variant="text-md/semibold" style={{ color: "var(--text-muted)" }}>
                            No more media in this channel!
                        </Text>
                    )}
                </div>
            </div>
        </Modal>
    );
}

const FilterButton = ({ label, type, activeFilter, onFilterChange }: { label: string; type: FilterType; activeFilter: FilterType; onFilterChange: (type: FilterType) => void }) => {
    const isActive = activeFilter === type;
    return <button onClick={() => onFilterChange(type)} className={`vc-gallery-filter-btn ${isActive ? "vc-gallery-filter-btn-active" : ""}`}>{label}</button>;
};

export default definePlugin({
    name: "GalleryMode",
    managedStyle: style,
    description: "Infinitely scrolling media gallery with filtering and message context jumping.",
    tags: ["Media", "Utility"],
    searchTerms: ["gallery", "media", "images", "videos", "gif"],
    authors: [{ name: "Sodroz", id: 145188106289545216n }],
    settings,
    contextMenus: {
        "channel-context": (children, { channel }) => {
            const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
            group.push(
                <Menu.MenuItem
                    id="vc-gallery-open"
                    label="Open Gallery View"
                    action={() => openModal(props => (
                        <ErrorBoundary>
                            <GalleryModal modalProps={props} channel={channel} />
                        </ErrorBoundary>
                    ))}
                />
            );
        },
    },
});
