import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findGroupChildrenByChildId } from "@api/ContextMenu";
import { Menu, Text, RestAPI, Modal, openModal, useState, useEffect, useRef } from "@webpack/common";
import { findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import ErrorBoundary from "@components/ErrorBoundary";
import "./style.css";

// Inlined from @equicordplugins/favouriteAnything/types for Vencord compat
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
};

type FilterType = "all" | "images" | "gifs" | "videos";

const JumpAction = findByPropsLazy("jumpToMessage");
const FavoriteButton = findComponentByCodeLazy<FavoriteButtonProps>("#{intl::GIF_TOOLTIP_ADD_TO_FAVORITES}");
const PAGE_SIZE = 100;

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
        description: "Number of columns (0 = auto-fill based on card size)",
        default: 0,
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
        // fall through
    }

    return cleanUrl;
}

function GalleryModal({ channel, modalProps }: { channel: any; modalProps: any }) {
    const columnCount = settings.store.gridColumns ?? 0;
    const gridColumns = columnCount > 0 ? String(columnCount) : "auto-fill";
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

    // Keep stateRef in sync with the latest committed React state
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
        return () => { mountedRef.current = false; };
    }, []);

    // Save gallery state on unmount (any close: jump, X button, click-outside)
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

            foundMessages.forEach((msg: any) => {
                const addMedia = (url: string, forceGif = false, sourceUrl?: string, proxyUrl?: string) => {
                    if (!url) return;
                    const normalizedUrl = normalizeUrl(url);
                    const normalizedSourceUrl = normalizeUrl(sourceUrl || url);
                    const normalizedProxyUrl = proxyUrl ? normalizeUrl(proxyUrl) : undefined;
                    const lowerUrl = url.toLowerCase();
                    const isVideoExt = !!lowerUrl.match(/\.(mp4|webm|mov)($|\?)/i);
                    const isGifExt = forceGif || !!lowerUrl.match(/\.(gif)($|\?)/i) || url.includes("tenor.com");
                    const key = `${msg.id}:${normalizedUrl}`;
                    if (!extractedMedia.some(item => item.key === key)) {
                        extractedMedia.push({
                            key,
                            url: normalizedUrl,
                            proxyUrl: normalizedProxyUrl,
                            sourceUrl: normalizedSourceUrl,
                            isGif: isGifExt,
                            isVideo: isVideoExt && !isGifExt,
                            messageId: msg.id
                        });
                    }
                };

                msg.attachments?.forEach((a: any) => {
                    if (a.content_type?.startsWith("image/") || a.content_type?.startsWith("video/"))
                        addMedia(a.url || a.proxy_url, false, undefined, a.proxy_url);
                });

                msg.embeds?.forEach((e: any) => {
                    if (e.type === "image" && e.image?.url)
                        addMedia(e.image.url, false, undefined, e.image.proxyURL);
                    else if (e.type === "video" && e.video?.url) {
                        addMedia(e.video.url, e.provider?.name === "Tenor" || e.url?.includes("tenor"), e.url || e.video.url, e.video.proxyURL);
                    }
                    else if (e.type === "gifv" && e.video?.url) {
                        addMedia(e.video.url, true, e.url || e.video.url, e.video.proxyURL);
                    }
                });
            });

            setMediaItems(prev => {
                const combined = isResetting ? extractedMedia : [...prev, ...extractedMedia];
                return combined.filter((v, i, a) => a.findIndex(t => t.key === v.key) === i);
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

    useEffect(() => {
        if (mediaItems.length === 0 && !isFetching) fetchOlderMessages();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Restore scroll position from cache after mount
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
        const isVideoGif = !!item.url.match(/\.(mp4|webm|mov)($|\?)/i);
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

    const displayedMedia = mediaItems.filter(item => {
        if (activeFilter === "videos") return item.isVideo;
        if (activeFilter === "gifs") return item.isGif;
        if (activeFilter === "images") return !item.isVideo && !item.isGif;
        return true;
    });

    return (
        <Modal {...modalProps} size="dynamic" title={`Gallery: ${channel.name}`}>
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
                <FilterButton label="All Media" type="all" />
                <FilterButton label="Images" type="images" />
                <FilterButton label="GIFs" type="gifs" />
                <FilterButton label="Videos" type="videos" />
            </div>

            <div style={{ color: "var(--text-muted)", fontSize: "13px", marginBottom: "12px" }}>
                {displayedMedia.length} items loaded{isFetching ? " (loading...)" : ""}
            </div>

            <div ref={scrollRef} style={{ maxHeight: "60vh", overflowY: "auto" }} onScroll={handleScroll}>
                <div className="vc-gallery-grid" style={{ "--vc-gallery-column-count": gridColumns } as any}>
                    {displayedMedia.map(item => {
                        const favoriteProps = getFavoriteButtonProps(item);

                        return (
                        <div key={item.key} className="vc-gallery-card">
                            {favoriteProps ? (
                                <div className="vc-gallery-fav-btn-wrap">
                                    <FavoriteButton {...favoriteProps} className="vc-gallery-fav-btn" />
                                </div>
                            ) : null}
                            {item.isVideo || (item.isGif && item.url.match(/\.(mp4|webm|mov)($|\?)/i)) ? (
                                <video
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
                                        src={getQualityUrl(item.url, gifQuality)}
                                        className="vc-gallery-media"
                                        alt=""
                                        loading="lazy"
                                        onLoad={e => rememberSize(item.key, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
                                    />
                                </a>
                            )}
                            <div className="vc-gallery-jump-btn" onClick={(e) => jumpToMessage(item.messageId, e)}>
                                Jump
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
    name: "ChannelGalleryMode",
    description: "Infinitely scrolling media gallery with filtering and message context jumping.",
    authors: [{ name: "Equicord User", id: 0n }],
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
