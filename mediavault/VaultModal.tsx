import { Logger } from "@utils/Logger";
import { Modal, React, Text, useEffect, useState } from "@webpack/common";

import { getAllVaultItems } from "./db";
import { hydrateVaultItems } from "./hydrate";
import type { MediaItem } from "./types";

const log = new Logger("GalleryModeVault");

export default function VaultModal({ modalProps }: { modalProps: any; }) {
    const [items, setItems] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                setLoading(true);
                const saved = await getAllVaultItems();
                const hydrated = await hydrateVaultItems(saved);
                if (!cancelled) setItems(hydrated);
            } catch (err) {
                log.error("Failed to load vault items", err);
                if (!cancelled) setError("Failed to load MediaVault");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, []);

    return (
        <Modal {...modalProps} size="dynamic" title="MediaVault">
            {loading ? <Text>Loading vault...</Text> : null}
            {error ? <Text>{error}</Text> : null}
            {!loading && !error && items.length === 0 ? <Text>No saved media yet.</Text> : null}
            {!loading && !error && items.length > 0 ? (
                <div className="vc-gallery-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
                    {items.map(item => (
                        <div key={item.id} className="vc-gallery-card">
                            {item.type.startsWith("video/") ? (
                                <video className="vc-gallery-media" src={item.url} controls muted loop />
                            ) : (
                                <img className="vc-gallery-media" src={item.url} alt="" />
                            )}
                        </div>
                    ))}
                </div>
            ) : null}
        </Modal>
    );
}
