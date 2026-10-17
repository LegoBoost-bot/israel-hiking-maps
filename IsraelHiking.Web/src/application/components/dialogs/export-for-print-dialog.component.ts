import { Component, inject, AfterViewInit, OnDestroy } from "@angular/core";
import { MatButton } from "@angular/material/button";
import { MatDialog, MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInput } from "@angular/material/input";
import { MatOption, MatSelect } from "@angular/material/select";
import { MatRadioButton, MatRadioGroup } from "@angular/material/radio";
import { MatCheckbox } from "@angular/material/checkbox";
import { FormsModule } from "@angular/forms";
import { Dir } from "@angular/cdk/bidi";
import { Store } from "@ngxs/store";
import * as maplibregl from "maplibre-gl";
import { Map, LngLatBounds } from "maplibre-gl";

import { ResourcesService } from "../../services/resources.service";
import { PrintService } from "../../services/print.service";
import { SpatialHelper } from "../../services/spatial.helper";
import { MapService } from "../../services/map.service";
import { PrintAreaSelectionService } from "../../services/print-area-selection.service";
import { SelectionRectangle } from "../../services/selection-rectangle";
import type { RouteData, LatLngAltTime, ApplicationState, Bounds } from "../../models";

/**
 * The options of the dialog, carried over when it closes for the user to select the area on the main
 * map and opens again afterwards.
 */
export type ExportForPrintDialogState = {
    format: "pdf" | "png";
    scale: "fit" | "1:50000" | "1:25000" | "custom";
    customScale: number;
    includeHillshade: boolean;
    mode: "area" | "all" | "route";
    splitToPages: boolean;
    routes: { id: string, name: string, selected: boolean }[];
    selectedArea: Bounds | null;
};

export type ExportForPrintDialogData = {
    route?: RouteData;
    state?: ExportForPrintDialogState;
};

@Component({
    selector: "export-for-print-dialog",
    templateUrl: "export-for-print-dialog.component.html",
    styleUrls: ["export-for-print-dialog.component.scss"],
    imports: [MatDialogModule, MatButton, MatFormFieldModule, MatInput, MatSelect, MatOption, FormsModule, Dir, MatRadioButton, MatRadioGroup, MatCheckbox]
})
export class ExportForPrintDialogComponent implements AfterViewInit, OnDestroy {
    public readonly resources = inject(ResourcesService);
    public readonly data = inject<ExportForPrintDialogData>(MAT_DIALOG_DATA);
    public readonly dialogRef = inject(MatDialogRef<ExportForPrintDialogComponent>);
    private readonly printService = inject(PrintService);
    private readonly mapService = inject(MapService);
    private readonly store = inject(Store);

    private readonly printAreaSelectionService = inject(PrintAreaSelectionService);
    private readonly matDialog = inject(MatDialog);

    public format: "pdf" | "png" = this.data.state?.format ?? "pdf";
    public scale: "fit" | "1:50000" | "1:25000" | "custom" = this.data.state?.scale ?? "fit";
    public customScale = this.data.state?.customScale ?? 25000;
    public orientation: "portrait" | "landscape" | "auto" = "auto";
    public includeHillshade = this.data.state?.includeHillshade ?? false;
    public warning: string | null = null;
    public pages: number | null = null;
    public mode: "area" | "all" | "route" = this.data.state?.mode ?? (this.data.route ? "route" : "all");
    public splitToPages = this.data.state?.splitToPages ?? false;
    public routes: { id: string, name: string, selected: boolean }[] = this.data.state?.routes ?? [];
    /**
     * The area the user marked on the preview map in "area" mode. It is kept when switching to another
     * mode, so that switching back does not lose it.
     */
    public selectedArea: Bounds | null = this.data.state?.selectedArea ?? null;
    private map: Map | null = null;
    private selectionRectangle: SelectionRectangle | null = null;

    /**
     * Opens the dialog at a width that fits its preview map, which the default width of a material
     * dialog is too narrow for on a desktop.
     */
    public static openDialog(dialog: MatDialog, data: ExportForPrintDialogData) {
        dialog.open<ExportForPrintDialogComponent, ExportForPrintDialogData>(ExportForPrintDialogComponent, {
            width: "90vw",
            maxWidth: "1000px",
            data
        });
    }

    constructor() {
        if (!this.data.route && !this.data.state) {
            const mapBounds = this.mapService.getMapBounds();
            const allRoutes = this.store.selectSnapshot((s: ApplicationState) => s.routes.present);
            for (const r of allRoutes.filter(r => r.state !== "Hidden")) {
                const routeLatlngs = this.getLatlngs(r);
                const isAnyPointInViewport = routeLatlngs.some(pt => {
                    return pt.lng >= mapBounds.southWest.lng && pt.lng <= mapBounds.northEast.lng &&
                        pt.lat >= mapBounds.southWest.lat && pt.lat <= mapBounds.northEast.lat;
                });
                if (isAnyPointInViewport) {
                    this.routes.push({ id: r.id, name: r.name, selected: true });
                }
            }
        }
    }

    public ngAfterViewInit(): void {
        this.map = new maplibregl.Map({
            container: "print-preview-map",
            style: {
                version: 8,
                sources: {
                    osm: {
                        type: "raster",
                        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                        tileSize: 256,
                        attribution: "&copy; OpenStreetMap"
                    }
                },
                layers: [{
                    id: "osm",
                    type: "raster",
                    source: "osm"
                }]
            },
            center: [35, 31],
            zoom: 7,
            attributionControl: false
        });
        this.map.on("load", () => {
            this.checkFit();
        });
        setTimeout(() => this.map?.resize(), 500);
    }

    public ngOnDestroy(): void {
        this.map?.remove();
    }

    public async export() {
        await this.printService.export(this.format, this.scale, this.customScale, this.orientation, this.mode === "route" ? this.data.route : undefined, this.mode, this.includeHillshade, this.splitToPages, this.routes.filter(r => !r.selected).map(r => r.id), this.mode === "area" ? this.selectedArea ?? undefined : undefined);
        this.dialogRef.close();
    }

    public checkFit() {
        this.updateSelectionArea();
        this.updatePreview();
        if (this.scale === "fit") {
            this.warning = null;
            this.pages = null;
            return;
        }

        const bounds = this.getPrintTargetBounds();
        if (bounds == null) {
            this.warning = null;
            this.pages = null;
            return;
        }

        this.pages = this.printService.getPagesCount(this.scale, this.customScale, this.orientation, bounds);

        if (!this.splitToPages && (this.pages ?? 0) > 1) {
            this.warning = "The route does not fit in a single page at this scale.";
        } else {
            this.warning = null;
        }
    }

    /**
     * Whether the selected area has to be exactly one page, which is the case when printing a single
     * page at a fixed scale - the page then decides the size of the area and the user can only move it.
     */
    public isSelectionLockedToPage(): boolean {
        return this.scale !== "fit" && !this.splitToPages;
    }

    /**
     * The area that will be printed: the selected area in "area" mode, and the bounds of the routes to
     * print otherwise, or null when there is nothing to print yet.
     */
    private getPrintTargetBounds(): Bounds | null {
        if (this.mode === "area") {
            return this.selectedArea;
        }
        const latlngs: LatLngAltTime[] = [];
        if (this.mode === "route" && this.data.route) {
            latlngs.push(...this.getLatlngs(this.data.route));
        } else if (this.mode === "all") {
            const allRoutes = this.store.selectSnapshot((s: ApplicationState) => s.routes.present);
            for (const r of allRoutes.filter(r => r.state !== "Hidden")) {
                if (this.routes.some(route => route.id === r.id && route.selected)) {
                    latlngs.push(...this.getLatlngs(r));
                }
            }
        }
        return latlngs.length > 0 ? SpatialHelper.getBounds(latlngs) : null;
    }

    /**
     * Closes the dialog while the user adjusts the selected area on the main map, and opens it again
     * with the same options once they are done.
     */
    public async selectAreaOnMap() {
        const state = this.getState();
        this.dialogRef.close();
        const area = await this.printAreaSelectionService.selectArea(this.selectedArea ?? this.mapService.getMapBounds(), this.isSelectionLockedToPage());
        ExportForPrintDialogComponent.openDialog(this.matDialog, { ...this.data, state: { ...state, selectedArea: area ?? state.selectedArea } });
    }

    private getState(): ExportForPrintDialogState {
        return {
            format: this.format,
            scale: this.scale,
            customScale: this.customScale,
            includeHillshade: this.includeHillshade,
            mode: this.mode,
            splitToPages: this.splitToPages,
            routes: this.routes,
            selectedArea: this.selectedArea
        };
    }

    /**
     * Shows, hides or locks the selected area on the preview map to match the current options.
     */
    private updateSelectionArea() {
        if (!this.map?.isStyleLoaded()) {
            return;
        }
        if (this.mode !== "area") {
            this.selectionRectangle?.remove();
            this.selectionRectangle = null;
            return;
        }
        if (this.selectionRectangle == null) {
            this.selectedArea ??= this.mapService.getMapBounds();
            this.map.fitBounds(SpatialHelper.boundsToMBBounds(this.selectedArea), { padding: 30, animate: false });
            this.selectionRectangle = new SelectionRectangle(this.map, this.selectedArea, area => {
                this.selectedArea = area;
                this.checkFit();
            });
        }
        const isLocked = this.isSelectionLockedToPage();
        if (isLocked) {
            this.lockSelectionToPage();
        }
        this.selectionRectangle.setLocked(isLocked);
        this.selectionRectangle.setArea(this.selectedArea!);
        if (isLocked) {
            this.selectionRectangle.ensureVisible(30);
        }
    }

    /**
     * Sets the size of the selected area to the size of a single page at the selected scale, around the
     * center of the area as it is now.
     */
    private lockSelectionToPage() {
        const area = this.selectedArea!;
        const params = this.printService.getPrintParams(this.scale, this.customScale, this.orientation, area, false);
        const center = SpatialHelper.getCenter([area.southWest, area.northEast]);
        const latDelta = (params.pageHeightMeters / 2) / 111320;
        const lngDelta = (params.pageWidthMeters / 2) / (111320 * Math.cos(center.lat * Math.PI / 180));
        this.selectedArea = {
            northEast: { lat: center.lat + latDelta, lng: center.lng + lngDelta },
            southWest: { lat: center.lat - latDelta, lng: center.lng - lngDelta }
        };
    }

    /**
     * Draws the routes and the outline of the printed pages on the preview map. The preview is only
     * zoomed to the printed area when it is derived from routes - in "area" mode the user controls it.
     */
    private updatePreview() {
        if (!this.map) return;
        if (!this.map.isStyleLoaded()) {
            this.map.once("styledata", () => this.checkFit());
            return;
        }

        if (this.map.getLayer("route")) {
            this.map.removeLayer("route");
            this.map.removeSource("route");
        }
        const allRoutes = this.store.selectSnapshot((s: ApplicationState) => s.routes.present);
        for (const r of allRoutes) {
            if (this.map.getLayer(`route-${r.id}`)) {
                this.map.removeLayer(`route-${r.id}`);
                this.map.removeSource(`route-${r.id}`);
            }
        }
        for (let i = 0; i < 100; i++) {
            if (this.map.getLayer(`page-${i}`)) {
                this.map.removeLayer(`page-${i}`);
                this.map.removeSource(`page-${i}`);
            } else {
                break;
            }
        }

        const bounds = this.getPrintTargetBounds();
        if (bounds == null) {
            return;
        }

        if (this.mode !== "area") {
            let printBounds: LngLatBounds;

            if (this.scale !== "fit") {
                const params = this.printService.getPrintParams(this.scale, this.customScale, this.orientation, bounds, this.splitToPages);

                const center = SpatialHelper.getCenter([bounds.southWest, bounds.northEast]);

                const latDelta = (params.totalHeightMeters / 2) / 111320;
                const lngDelta = (params.totalWidthMeters / 2) / (111320 * Math.cos(center.lat * Math.PI / 180));

                printBounds = new LngLatBounds(
                    [center.lng - lngDelta, center.lat - latDelta],
                    [center.lng + lngDelta, center.lat + latDelta]
                );
            } else {
                printBounds = new LngLatBounds(
                    [bounds.southWest.lng, bounds.southWest.lat],
                    [bounds.northEast.lng, bounds.northEast.lat]
                );
            }

            this.map.fitBounds(printBounds, { padding: 20 });
        }

        const colors = ["blue", "green", "purple", "orange", "magenta"];
        if (this.mode === "route" && this.data.route) {
            this.map.addSource("route", {
                type: "geojson",
                data: {
                    type: "FeatureCollection",
                    features: this.data.route.segments.map(segment => ({
                        type: "Feature",
                        properties: {},
                        geometry: {
                            type: "LineString",
                            coordinates: segment.latlngs.map(l => [l.lng, l.lat] as [number, number])
                        }
                    }))
                }
            });
            this.map.addLayer({
                id: "route",
                type: "line",
                source: "route",
                paint: {
                    "line-color": "blue",
                    "line-width": 3
                }
            });
        } else if (this.mode === "all") {
            let colorIndex = 0;
            for (const r of allRoutes.filter(r => r.state !== "Hidden")) {
                if (this.routes.some(route => route.id === r.id && route.selected)) {
                    const color = colors[colorIndex % colors.length];
                    this.map.addSource(`route-${r.id}`, {
                        type: "geojson",
                        data: {
                            type: "FeatureCollection",
                            features: r.segments.map(segment => ({
                                type: "Feature",
                                properties: {},
                                geometry: {
                                    type: "LineString",
                                    coordinates: segment.latlngs.map(l => [l.lng, l.lat] as [number, number])
                                }
                            }))
                        }
                    });
                    this.map.addLayer({
                        id: `route-${r.id}`,
                        type: "line",
                        source: `route-${r.id}`,
                        paint: {
                            "line-color": color,
                            "line-width": 3
                        }
                    });
                    colorIndex++;
                }
            }
        }

        if (this.scale !== "fit" && this.splitToPages) {
            const params = this.printService.getPrintParams(this.scale, this.customScale, this.orientation, bounds, this.splitToPages);

            for (let r = 0; r < params.rows; r++) {
                for (let c = 0; c < params.cols; c++) {
                    const centerLat = bounds.southWest.lat + (params.totalHeightMeters - (r * (params.pageHeightMeters - params.overlapMm * params.scaleValue / 1000)) - (params.pageHeightMeters / 2) + params.shiftY) / 111320;
                    const centerLng = bounds.southWest.lng + (c * (params.pageWidthMeters - params.overlapMm * params.scaleValue / 1000) + (params.pageWidthMeters / 2) - params.shiftX) / (111320 * Math.cos(bounds.southWest.lat * Math.PI / 180));

                    const latDelta = (params.pageHeightMeters / 2) / 111320;
                    const lngDelta = (params.pageWidthMeters / 2) / (111320 * Math.cos(centerLat * Math.PI / 180));

                    this.addPageOutline(r * params.cols + c, centerLng, centerLat, lngDelta, latDelta);
                }
            }
        } else if (this.scale !== "fit" && !this.splitToPages && this.mode !== "area") {
            const params = this.printService.getPrintParams(this.scale, this.customScale, this.orientation, bounds, false);

            const center = SpatialHelper.getCenter([bounds.southWest, bounds.northEast]);
            const latDelta = (params.pageHeightMeters / 2) / 111320;
            const lngDelta = (params.pageWidthMeters / 2) / (111320 * Math.cos(center.lat * Math.PI / 180));

            this.addPageOutline(0, center.lng, center.lat, lngDelta, latDelta);
        }
    }

    private addPageOutline(index: number, centerLng: number, centerLat: number, lngDelta: number, latDelta: number) {
        this.map!.addSource(`page-${index}`, {
            type: "geojson",
            data: {
                type: "Feature",
                properties: {},
                geometry: {
                    type: "Polygon",
                    coordinates: [[
                        [centerLng - lngDelta, centerLat - latDelta],
                        [centerLng + lngDelta, centerLat - latDelta],
                        [centerLng + lngDelta, centerLat + latDelta],
                        [centerLng - lngDelta, centerLat + latDelta],
                        [centerLng - lngDelta, centerLat - latDelta]
                    ]]
                }
            }
        });
        this.map!.addLayer({
            id: `page-${index}`,
            type: "line",
            source: `page-${index}`,
            paint: {
                "line-color": "red",
                "line-width": 2,
                "line-dasharray": [2, 2]
            }
        });
    }

    private getLatlngs(routeData: { segments?: readonly { latlngs?: readonly LatLngAltTime[] }[]; markers?: readonly { latlng?: LatLngAltTime }[] }): LatLngAltTime[] {
        let latLngs: LatLngAltTime[] = [];
        for (const segment of routeData.segments ?? []) {
            if (segment.latlngs) {
                latLngs = latLngs.concat(segment.latlngs as LatLngAltTime[]);
            }
        }
        for (const marker of routeData.markers ?? []) {
            if (marker.latlng) {
                latLngs.push(marker.latlng);
            }
        }
        return latLngs;
    }
}
