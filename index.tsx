import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findGroupChildrenByChildId } from "@api/ContextMenu";
import { Menu, Text, RestAPI, Modal, openModal, useState, useEffect, useRef, useMemo } from "@webpack/common";
import { findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import ErrorBoundary from "@components/ErrorBoundary";
import * as React from "react";
import "./style.css";

enum FavouriteItemFormat { NONE = 0, IMAGE = 1, VIDEO = 2 }
interface FavoriteButtonProps {
    format: FavouriteItemFormat;
    src: string;
    url: string;
    gifSrc?: string;
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
    // Best-known dimensions at parse time. Populated from embed/attachment metadata
    // first, then CDN URL query params as fallback. Used for aspect-ratio pre-layout
    // in masonry so cards don't reflow after images load.
    knownWidth?: number;
    knownHeight?: number;
};

type FilterType = "all" | "images" | "gifs" | "videos";

const JumpAction = findByPropsLazy("jumpToMessage");
const FavoriteButton = findComponentByCodeLazy<FavoriteButtonProps>("#{intl::GIF_TOOLTIP_ADD_TO_FAVORITES}");
const PAGE_SIZE = 100;
const VIDEO_EXT_RE = /\.(mp4|webm|mov)($|\?)/i;

const Quality = {
    High: 1,
    Reasonable: 2,
    Low: 3,
    Horrible: 4,
} as const;

const qualities = [
    { giphy: "giphy", tenor: "Ax", video: "Po" }, // High ~ 480-native
    { giphy: "480w", tenor: "A5", video: "P3" },   // Reasonable ~ 360
    { giphy: "200", tenor: "A1", video: "P2" },    // Low ~ 200
    { giphy: "100", tenor: "A2", video: "P4" },    // Horrible ~ 120
];

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
    searchOffset: number;
    hasMore: boolean;
    mediaSizes: Record<string, { width: number; height: number; }>;
    activeFilter: FilterType;
    scrollTop: number;
    timestamp: number;
};

let channelCache: { channelId: string; state: GalleryCache; } | null = null;

function normalizeUrl(url: string) {
    return url.startsWith("//") ? `https:${url}` : url;
}

// Discord CDN URLs often embed width/height as query params — use these for masonry
// pre-layout so we don't have to wait for images to load before placing them.
function parseCdnDimensions(url: string): { width: number; height: number; } | null {
    try {
        const parsed = new URL(url);
        const w = parseInt(parsed.searchParams.get("width") ?? "", 10);
        const h = parseInt(parsed.searchParams.get("height") ?? "", 10);
        if (w > 0 && h > 0) return { width: w, height: h };
    } catch { /* ignore */ }
    return null;
}

async function copyMediaToClipboard(url: string, isVideo: boolean): Promise<boolean> {
    if (isVideo) {
        // Can't write video to clipboard — fall back to URL copy
        await navigator.clipboard.writeText(url);
        return false; // false = copied URL, not image
    }
    try {
        const res = await fetch(url);
        const blob = await res.blob();
        const item = new ClipboardItem({ [blob.type]: blob });
        await navigator.clipboard.write([item]);
        return true; // true = copied image data
    } catch {
        // Fallback to URL if blob copy fails (e.g. cross-origin restrictions)
        await navigator.clipboard.writeText(url);
        return false;
    }
}

// Returns the best aspect ratio string we can determine without waiting for load.
// Priority: known dims from parse time → mediaSizes from a previous load → 4:3 fallback.
// The fallback causes one reflow per unknown item on first open, then mediaSizes takes over.
function getAspectRatio(item: MediaItem, mediaSizes: Record<string, { width: number; height: number; }>): string {
    const w = item.knownWidth ?? mediaSizes[item.key]?.width;
    const h = item.knownHeight ?? mediaSizes[item.key]?.height;
    return w && h ? `${w} / ${h}` : "4 / 3";
}

// Single observer instance reused across renders. rootMargin triggers image load
// 800px before the image scrolls into view, hiding network latency behind scroll time.
let lazyObserver: IntersectionObserver | null = null;
function getLazyObserver(): IntersectionObserver {
    if (!lazyObserver) {
        lazyObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const img = entry.target as HTMLImageElement;
                const src = img.dataset.src;
                if (src) {
                    img.src = src;
                    delete img.dataset.src;
                }
                lazyObserver!.unobserve(img);
            }
        }, { rootMargin: "0px 0px 800px 0px" });
    }
    return lazyObserver;
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
        return `https://i.giphy.com/media/${code}/${q.giphy}.webp`;
    }

    try {
        const parsed = new URL(cleanUrl);
        if (parsed.hostname === "cdn.discordapp.com" || parsed.hostname.endsWith("discordapp.net")) {
            parsed.searchParams.set("format", "webp");
            parsed.searchParams.set("animated", "true");
            return parsed.toString();
        }
    } catch {
    }

    return cleanUrl;
}

function GalleryModal({ channel, modalProps }: { channel: any; modalProps: any }) {
    const gifQuality = settings.store.gifQuality ?? Quality.High;

    const cacheTtlMinutes = settings.store.cacheTtlMinutes ?? 30;
    const cacheTtlMs = cacheTtlMinutes > 0 ? cacheTtlMinutes * 60_000 : 0;

    const saved = cacheTtlMs > 0
        && channelCache?.channelId === channel.id
        && Date.now() - channelCache.state.timestamp < cacheTtlMs
        ? channelCache.state
        : null;

    const [isFetching, setIsFetching] = useState(false);
    const [activeFilter, setActiveFilter] = useState<FilterType>(saved?.activeFilter ?? "all");
    const [mediaItems, setMediaItems] = useState<MediaItem[]>(saved?.mediaItems ?? []);
    const [searchOffset, setSearchOffset] = useState(saved?.searchOffset ?? 0);
    const [hasMore, setHasMore] = useState(saved?.hasMore ?? true);
    const [mediaSizes, setMediaSizes] = useState<Record<string, { width: number; height: number; }>>(saved?.mediaSizes ?? {});
    const [layoutMode, setLayoutMode] = useState<"grid" | "masonry">(
        (settings.store.layoutMode as "grid" | "masonry") ?? "grid"
    );
    const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
    const [columnSetting, setColumnSetting] = useState(settings.store.gridColumns ?? 4);
    const [containerWidth, setContainerWidth] = useState(0);

    const gridRef = useRef<HTMLDivElement>(null);

    // 0 = adaptive: derive column count from container width.
    // Uses (containerWidth + gap) / (minCardWidth + gap) so breakpoints are consistent.
    const effectiveColumns = useMemo(() => {
        if (columnSetting > 0) return columnSetting;
        if (!containerWidth) return 4;
        return Math.max(2, Math.floor((containerWidth + 12) / (200 + 12)));
    }, [columnSetting, containerWidth]);

    const mountedRef = useRef(true);
    const fetchingRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const scrollTopRef = useRef(0);
    const stateRef = useRef<GalleryCache>({
        mediaItems: [],
        searchOffset: 0,
        hasMore: true,
        mediaSizes: {},
        activeFilter: "all",
        scrollTop: 0,
        timestamp: 0,
    });

    useEffect(() => {
        stateRef.current = {
            mediaItems,
            searchOffset,
            hasMore,
            mediaSizes,
            activeFilter,
            scrollTop: scrollTopRef.current,
            timestamp: Date.now(),
        };
    });

    useEffect(() => {
        return () => {
            mountedRef.current = false;
            // Disconnect the shared observer on unmount so stale img refs don't linger
            lazyObserver?.disconnect();
            lazyObserver = null;
        };
    }, []);

    useEffect(() => {
        if (cacheTtlMs <= 0) return;

        return () => {
            channelCache = {
                channelId: channel.id,
                state: {
                    ...stateRef.current,
                    scrollTop: scrollTopRef.current,
                    timestamp: Date.now(),
                },
            };
        };
    }, [channel.id, cacheTtlMs]);

    useEffect(() => {
        if (!gridRef.current) return;
        const ro = new ResizeObserver(entries => {
            setContainerWidth(entries[0].contentRect.width);
        });
        ro.observe(gridRef.current);
        return () => ro.disconnect();
    }, []);

    const setFetching = (value: boolean) => {
        fetchingRef.current = value;
        setIsFetching(value);
    };

    const rememberSize = (key: string, width: number, height: number) => {
        if (!width || !height) return;

        setMediaSizes(prev => {
            const current = prev[key];
            if (current?.width === width && current?.height === height) return prev;
            return { ...prev, [key]: { width, height } };
        });
    };

    const resetGalleryState = () => {
        setMediaItems([]);
        setMediaSizes({});
        setSearchOffset(0);
        setHasMore(true);
    };

    const jumpToMessage = (messageId: string, e: any) => {
        e.preventDefault();
        e.stopPropagation();
        if (!JumpAction?.jumpToMessage) {
            console.error("[GalleryMode] jumpToMessage module not found");
            return;
        }
        JumpAction.jumpToMessage({
            channelId: channel.id,
            messageId,
            flash: true,
            jumpType: "INSTANT"
        });
        modalProps.onClose();
    };

    const fetchOlderMessages = async (isResetting = false, targetFilter = activeFilter) => {
        const currentOffset = isResetting ? 0 : searchOffset;
        const currentHasMore = isResetting ? true : hasMore;
        if (fetchingRef.current || !currentHasMore) return;
        setFetching(true);

        try {
            const isGuild = !!channel.guild_id;
            const searchUrl = isGuild
                ? `/guilds/${channel.guild_id}/messages/search`
                : `/channels/${channel.id}/messages/search`;

            let searchTag = "image";
            if (targetFilter === "videos") searchTag = "video";
            else if (targetFilter === "gifs") searchTag = "embed";
            else if (targetFilter === "all") searchTag = "file";

            const queryParams: any = { has: searchTag, offset: currentOffset };
            if (isGuild) queryParams.channel_id = channel.id;
            if (channel.nsfw || channel.isNSFW?.()) queryParams.include_nsfw = true;

            const response = await RestAPI.get({ url: searchUrl, query: queryParams });

            if (!mountedRef.current) return;

            if (response.status === 202) {
                console.warn("[GalleryMode] Discord is indexing this chat.");
                return;
            }

            if (!response.body?.messages?.length) {
                setHasMore(false);
                return;
            }

            const foundMessages = response.body.messages.map((hitGroup: any[]) => hitGroup[0]);
            const extractedMedia: MediaItem[] = [];
            const seenKeys = new Set<string>();

            foundMessages.forEach((msg: any) => {
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
                    // Prefer explicit dims from embed/attachment metadata, then CDN URL params
                    const cdnDims = (!w || !h) ? parseCdnDimensions(normalizedProxyUrl ?? normalizedUrl) : null;
                    extractedMedia.push({
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
                    if (a.content_type?.startsWith("image/") || a.content_type?.startsWith("video/"))
                        addMedia(a.url || a.proxy_url, false, undefined, a.proxy_url, a.width, a.height);
                });

                msg.embeds?.forEach((e: any) => {
                    if (e.type === "image" && e.image?.url)
                        addMedia(e.image.url, false, undefined, e.image.proxyURL, e.image.width, e.image.height);
                    else if (e.type === "video" && e.video?.url) {
                        addMedia(e.video.url, e.provider?.name === "Tenor" || e.url?.includes("tenor"), e.url || e.video.url, e.video.proxyURL, e.video.width, e.video.height);
                    }
                    else if (e.type === "gifv" && e.video?.url) {
                        addMedia(e.video.url, true, e.url || e.video.url, e.video.proxyURL, e.video.width, e.video.height);
                    }
                });
            });

            setMediaItems(prev => {
                if (isResetting) return extractedMedia;
                const seen = new Set(prev.map(item => item.key));
                const newItems = extractedMedia.filter(item => !seen.has(item.key));
                return [...prev, ...newItems];
            });

            setSearchOffset(currentOffset + PAGE_SIZE);

            if (response.body.total_results <= currentOffset + PAGE_SIZE) {
                setHasMore(false);
            }
        } catch (error) {
            console.error("[GalleryMode] Search API failed:", error);
        } finally {
            if (mountedRef.current) setFetching(false);
        }
    };

    const initialFetchDone = useRef(mediaItems.length > 0);

    useEffect(() => {
        if (initialFetchDone.current) return;
        initialFetchDone.current = true;
        fetchOlderMessages();
    }, []);

    useEffect(() => {
        if (!saved?.scrollTop || !scrollRef.current) return;
        const el = scrollRef.current;
        const timer = setTimeout(() => {
            el.scrollTop = saved.scrollTop!;
        }, 50);
        return () => clearTimeout(timer);
    }, []);

    const handleScroll = (e: any) => {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        scrollTopRef.current = scrollTop;
        if (scrollHeight - scrollTop <= clientHeight + 800) fetchOlderMessages();
    };

    const handleFilterChange = (type: FilterType) => {
        if (activeFilter === type) return;
        channelCache = null;
        setActiveFilter(type);
        resetGalleryState();
        fetchOlderMessages(true, type);
    };

    const getFavoriteButtonProps = (item: MediaItem) => {
        if (!item.isGif) return null;

        const size = mediaSizes[item.key];
        if (!size) return null;

        // Mirror native embed: VIDEO format for mp4/webm sources, IMAGE for static GIFs
        const isVideoGif = VIDEO_EXT_RE.test(item.url);
        const format = isVideoGif ? FavouriteItemFormat.VIDEO : FavouriteItemFormat.IMAGE;
        // Prefer CDN proxy URL for src (matches native embed EmbedAccessory behavior)
        const src = item.proxyUrl || item.url;

        return {
            format,
            src,
            url: getGifFavoriteUrl(item),
            width: size.width,
            height: size.height
        } satisfies FavoriteButtonProps;
    };

    const FilterButton = ({ label, type }: { label: string; type: FilterType }) => {
        const isActive = activeFilter === type;
        return (
            <button
                onClick={() => handleFilterChange(type)}
                className={`vc-gallery-filter-btn ${isActive ? "vc-gallery-filter-btn-active" : ""}`}
            >
                {label}
            </button>
        );
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
        setTimeout(() => setCopyFeedback(null), 2000);
    };

    const handleDownload = async (item: MediaItem, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const url = item.proxyUrl || item.url;
        try {
            const res = await fetch(url);
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = objectUrl;
            const ext = blob.type.split("/")[1] || url.split(".").pop()?.split("?")[0] || "bin";
            a.download = `${item.messageId}.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(objectUrl);
        } catch {
            window.open(url, "_blank");
        }
    };

    return (
        <Modal {...modalProps} size="dynamic" title={`Gallery: ${channel.name}`}>
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
                <FilterButton label="All Media" type="all" />
                <FilterButton label="Images" type="images" />
                <FilterButton label="GIFs" type="gifs" />
                <FilterButton label="Videos" type="videos" />
                <div style={{ marginLeft: "auto", display: "flex", gap: "6px", alignItems: "center" }}>
                    <input
                        type="range"
                        min={0} max={8} step={1}
                        value={columnSetting}
                        onChange={e => {
                            const val = Number(e.target.value);
                            settings.store.gridColumns = val;
                            setColumnSetting(val);
                        }}
                        className="vc-gallery-col-slider"
                        title="Columns (0 = adaptive)"
                    />
                    <span className="vc-gallery-col-label">
                        {columnSetting === 0 ? "Auto" : columnSetting}
                    </span>
                    <button
                        onClick={() => setLayoutMode("grid")}
                        className={`vc-gallery-filter-btn vc-gallery-layout-btn ${layoutMode === "grid" ? "vc-gallery-filter-btn-active" : ""}`}
                        title="Square grid"
                    >⊞</button>
                    <button
                        onClick={() => setLayoutMode("masonry")}
                        className={`vc-gallery-filter-btn vc-gallery-layout-btn ${layoutMode === "masonry" ? "vc-gallery-filter-btn-active" : ""}`}
                        title="Masonry"
                    >⬚</button>
                </div>
            </div>

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
                    style={{ "--vc-gallery-column-count": effectiveColumns } as any}
                >
                    {displayedMedia.map(item => {
                        const favoriteProps = getFavoriteButtonProps(item);
                        const isVideoContent = item.isVideo || (item.isGif && VIDEO_EXT_RE.test(item.url));
                        const aspectRatio = getAspectRatio(item, mediaSizes);
                        // Grid mode uses fixed 1/1, masonry uses natural aspect ratio
                        const cardStyle = layoutMode === "masonry" ? { aspectRatio } : {};

                        return (
                        <div key={item.key} className={`vc-gallery-card ${layoutMode === "masonry" ? "vc-gallery-card-masonry" : ""}`} style={cardStyle}>
                            {favoriteProps ? (
                                <div className="vc-gallery-fav-btn-wrap">
                                    <FavoriteButton {...favoriteProps} className="vc-gallery-fav-btn" />
                                </div>
                            ) : null}
                            {isVideoContent ? (
                                <video
                                    ref={el => { if (el) el.muted = true; }}
                                    src={getQualityUrl(item.url, gifQuality)}
                                    controls={!item.isGif}
                                    autoPlay={item.isGif}
                                    muted
                                    loop
                                    className="vc-gallery-media"
                                    onLoadedMetadata={e => rememberSize(item.key, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                                />
                            ) : (
                                <a href={item.url} target="_blank" rel="noreferrer" style={{ display: "block", width: "100%", height: "100%" }}>
                                    <img
                                        data-src={getQualityUrl(item.url, gifQuality)}
                                        className="vc-gallery-media"
                                        alt=""
                                        ref={el => {
                                            if (!el) return;
                                            if (el.src) return; // already loaded
                                            getLazyObserver().observe(el);
                                        }}
                                        onLoad={e => rememberSize(item.key, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
                                    />
                                </a>
                            )}
                            <div className="vc-gallery-card-actions">
                                <div
                                    className="vc-gallery-action-btn"
                                    title="Copy"
                                    onClick={e => handleCopy(item, e)}
                                >⎘</div>
                                <div
                                    className="vc-gallery-action-btn"
                                    title="Download"
                                    onClick={e => handleDownload(item, e)}
                                >↓</div>
                                <div
                                    className="vc-gallery-action-btn"
                                    title="Jump to message"
                                    onClick={e => jumpToMessage(item.messageId, e)}
                                >↗</div>
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
                                padding: "12px 24px", borderRadius: "8px", border: "none",
                                cursor: isFetching ? "not-allowed" : "pointer",
                                backgroundColor: isFetching ? "var(--background-modifier-active)" : "var(--brand-experiment)",
                                color: "white", fontWeight: "bold", fontSize: "16px"
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

export default definePlugin({
    name: "GalleryView",
    description: "Infinitely scrolling media gallery with filtering and message context jumping.",
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
        }
    }
});
