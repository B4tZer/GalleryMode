import { Text, React, showToast, Toasts } from "@webpack/common";

import { deleteVaultItem } from "./db";
import type { MediaItem } from "./types";

export function VaultEngine({ items, layoutMode = "grid", onRemove }: { items: MediaItem[]; layoutMode?: "grid" | "masonry"; onRemove?: (item: MediaItem) => void; }) {
    if (!items.length) return <Text>No saved media yet.</Text>;

    const handleRemove = async (item: MediaItem, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        try {
            await deleteVaultItem(item.id);
            onRemove?.(item);
            showToast("Removed from Vault", Toasts.Type.SUCCESS);
        } catch {
            showToast("Failed to remove from Vault", Toasts.Type.FAILURE);
        }
    };

    return (
        <div className={layoutMode === "masonry" ? "vc-gallery-masonry" : "vc-gallery-grid"} style={{ gridTemplateColumns: layoutMode === "grid" ? "repeat(auto-fill, minmax(200px, 1fr))" : undefined }}>
            {items.map(item => (
                <div key={item.id} className={`vc-gallery-card ${layoutMode === "masonry" ? "vc-gallery-card-masonry" : ""}`} style={layoutMode === "masonry" ? { aspectRatio: item.width && item.height ? `${item.width} / ${item.height}` : "1 / 1" } : {}}>
                    {item.type.startsWith("video/") ? (
                        <video className="vc-gallery-media" src={item.url} controls muted loop />
                    ) : (
                        <img className="vc-gallery-media" src={item.url} alt="" />
                    )}
                    <div className="vc-gallery-card-actions">
                        <div className="vc-gallery-action-btn" title="Remove from Vault" onClick={e => handleRemove(item, e)}>−</div>
                    </div>
                </div>
            ))}
        </div>
    );
}
