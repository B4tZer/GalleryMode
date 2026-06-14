import { getAllVaultItems } from "../db";
import { hydrateVaultItems } from "../hydrate";
import type { MediaItem } from "../types";

export async function loadVaultMedia(): Promise<MediaItem[]> {
    const saved = await getAllVaultItems();
    return hydrateVaultItems(saved);
}
