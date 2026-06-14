import { Modal, React, Text, useEffect, useState } from "@webpack/common";

import { loadVaultMedia } from "./sources/vault";
import { VaultEngine } from "./engine";
import type { MediaItem } from "./types";

export default function MediaSuite({ modalProps }: { modalProps: any; channel: any; }) {
    const [vaultItems, setVaultItems] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [layoutMode, setLayoutMode] = useState<"grid" | "masonry">("grid");

    useEffect(() => {
        (async () => {
            setLoading(true);
            setVaultItems(await loadVaultMedia());
            setLoading(false);
        })();
    }, []);

    const handleLayoutChange = (nextLayout: "grid" | "masonry") => {
        setLayoutMode(nextLayout);
    };

    const handleVaultRemove = (item: MediaItem) => {
        setVaultItems(prev => prev.filter(saved => saved.id !== item.id));
    };

    return (
        <Modal {...modalProps} size="dynamic" title="Vault">
            <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
                <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Saved media</div>
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button className={`vc-gallery-filter-btn ${layoutMode === "grid" ? "vc-gallery-filter-btn-active" : ""}`} onClick={() => handleLayoutChange("grid")} title="Square grid">⊞</button>
                    <button className={`vc-gallery-filter-btn ${layoutMode === "masonry" ? "vc-gallery-filter-btn-active" : ""}`} onClick={() => handleLayoutChange("masonry")} title="Masonry">⬚</button>
                </div>
            </div>
            {loading ? <Text>Loading...</Text> : null}
            {!loading ? <VaultEngine items={vaultItems} layoutMode={layoutMode} onRemove={handleVaultRemove} /> : null}
        </Modal>
    );
}
