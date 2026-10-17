import { inject, Service, signal } from "@angular/core";

import { MapService } from "./map.service";
import { SelectionRectangle } from "./selection-rectangle";
import type { Bounds } from "../models";

/**
 * Lets the user mark the area to print on the main map, which is roomier than the print dialog's
 * preview - on a phone the preview is too small to drag a rectangle on.
 */
@Service()
export class PrintAreaSelectionService {
    private readonly mapService = inject(MapService);

    public readonly isSelecting = signal(false);
    /**
     * Whether the area is the size of a single printed page, and can therefore only be moved.
     */
    public readonly isLocked = signal(false);
    private rectangle: SelectionRectangle | null = null;
    private resolve: ((area: Bounds | null) => void) | null = null;

    /**
     * Shows the area on the main map for the user to adjust.
     * @returns the adjusted area once the user confirms it, or null when they cancel.
     */
    public selectArea(area: Bounds, isLocked: boolean): Promise<Bounds | null> {
        this.finish(null);
        this.rectangle = new SelectionRectangle(this.mapService.map, area, () => { });
        this.rectangle.setLocked(isLocked);
        this.isLocked.set(isLocked);
        this.isSelecting.set(true);
        this.mapService.fitBounds(area, 50);
        return new Promise(resolve => this.resolve = resolve);
    }

    public confirm() {
        this.finish(this.rectangle?.getArea() ?? null);
    }

    public cancel() {
        this.finish(null);
    }

    private finish(area: Bounds | null) {
        this.rectangle?.remove();
        this.rectangle = null;
        this.isSelecting.set(false);
        this.resolve?.(area);
        this.resolve = null;
    }
}
