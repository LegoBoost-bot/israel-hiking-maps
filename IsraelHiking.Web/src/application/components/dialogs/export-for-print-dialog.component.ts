import { Component, inject, AfterViewInit, OnDestroy } from "@angular/core";
import { MatButton } from "@angular/material/button";
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInput } from "@angular/material/input";
import { MatOption, MatSelect } from "@angular/material/select";
import { MatRadioButton, MatRadioGroup } from "@angular/material/radio";
import { MatCheckbox } from "@angular/material/checkbox";
import { FormsModule } from "@angular/forms";
import { Dir } from "@angular/cdk/bidi";
import { Store } from "@ngxs/store";
import { ResourcesService } from "../../services/resources.service";
import { PrintService } from "../../services/print.service";
import { SpatialService } from "../../services/spatial.service";
import { MapService } from "../../services/map.service";
import { RouteData, LatLngAltTime, ApplicationState } from "../../models";
import maplibregl, { Map, LngLatBounds } from "maplibre-gl";

export type ExportForPrintDialogData = {
    route?: RouteData;
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

    public format: "pdf" | "png" = "pdf";
    public scale: "fit" | "1:50000" | "1:25000" | "custom" = "fit";
    public customScale = 25000;
    public orientation: "portrait" | "landscape" | "auto" = "auto";
    public includeHillshade = false;
    public warning: string | null = null;
    public pages: number | null = null;
    public mode: "view" | "all" | "route" = this.data.route ? "route" : "all";
    public splitToPages = false;
    public routes: { id: string, name: string, selected: boolean }[] = [];
    private map: Map | null = null;

    constructor() {
        if (!this.data.route) {
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
            this.updatePreview();
        });
        setTimeout(() => this.map?.resize(), 500);
    }

    public ngOnDestroy(): void {
        this.map?.remove();
    }

    public async export() {
        await this.printService.export(this.format, this.scale, this.customScale, this.orientation, this.mode === "route" ? this.data.route : undefined, this.mode, this.includeHillshade, this.splitToPages, this.routes.filter(r => !r.selected).map(r => r.id));
        this.dialogRef.close();
    }

    public checkFit() {
        this.updatePreview();
        if (this.scale === "fit") {
            this.warning = null;
            this.pages = null;
            return;
        }

        let latlngs: LatLngAltTime[] = [];
        if (this.mode === "route" && this.data.route) {
            latlngs = this.getLatlngs(this.data.route);
        } else if (this.mode === "all") {
            const allRoutes = this.store.selectSnapshot((s: ApplicationState) => s.routes.present);
            for (const r of allRoutes.filter(r => r.state !== "Hidden")) {
                if (this.routes.some(route => route.id === r.id && route.selected)) {
                    latlngs.push(...this.getLatlngs(r));
                }
            }
        }

        if (latlngs.length === 0) {
            this.warning = null;
            this.pages = null;
            return;
        }

        const bounds = SpatialService.getBounds(latlngs);
        
        this.pages = this.printService.getPagesCount(this.scale, this.customScale, this.orientation, bounds);

        // Apply margins for print (e.g., 10mm)
        if (!this.splitToPages && (this.pages ?? 0) > 1) {
            this.warning = "The route does not fit in a single page at this scale.";
        } else {
            this.warning = null;
        }
    }

    private updatePreview() {
        if (!this.map) return;
        if (!this.map.isStyleLoaded()) {
            this.map.once("styledata", () => this.updatePreview());
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

        let latlngs: LatLngAltTime[] = [];
        if (this.mode === "route" && this.data.route) {
            latlngs = this.getLatlngs(this.data.route);
        } else if (this.mode === "all") {
            for (const r of allRoutes.filter(r => r.state !== "Hidden")) {
                if (this.routes.some(route => route.id === r.id && route.selected)) {
                    latlngs.push(...this.getLatlngs(r));
                }
            }
        }

        if (latlngs.length > 0) {
            const bounds = SpatialService.getBounds(latlngs);
            let printBounds: LngLatBounds;

            if (this.scale !== "fit") {
                const params = this.printService.getPrintParams(this.scale, this.customScale, this.orientation, bounds, this.splitToPages);
                
                const center = SpatialService.getCenter([bounds.southWest, bounds.northEast]);
                
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

            // Add page rectangles
            if (this.scale !== "fit" && this.splitToPages) {
                const params = this.printService.getPrintParams(this.scale, this.customScale, this.orientation, bounds, this.splitToPages);

                for (let r = 0; r < params.rows; r++) {
                    for (let c = 0; c < params.cols; c++) {
                        const centerLat = bounds.southWest.lat + (params.totalHeightMeters - (r * (params.pageHeightMeters - params.overlapMm * params.scaleValue / 1000)) - (params.pageHeightMeters / 2) + params.shiftY) / 111320;
                        const centerLng = bounds.southWest.lng + (c * (params.pageWidthMeters - params.overlapMm * params.scaleValue / 1000) + (params.pageWidthMeters / 2) - params.shiftX) / (111320 * Math.cos(bounds.southWest.lat * Math.PI / 180));
                        
                        const latDelta = (params.pageHeightMeters / 2) / 111320;
                        const lngDelta = (params.pageWidthMeters / 2) / (111320 * Math.cos(centerLat * Math.PI / 180));
                        
                        this.map.addSource(`page-${r * params.cols + c}`, {
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
                        this.map.addLayer({
                            id: `page-${r * params.cols + c}`,
                            type: "line",
                            source: `page-${r * params.cols + c}`,
                            paint: {
                                "line-color": "red",
                                "line-width": 2,
                                "line-dasharray": [2, 2]
                            }
                        });
                    }
                }
            } else if (this.scale !== "fit" && !this.splitToPages) {
                // Show single page boundary
                const params = this.printService.getPrintParams(this.scale, this.customScale, this.orientation, bounds, false);

                const center = SpatialService.getCenter([bounds.southWest, bounds.northEast]);
                const latDelta = (params.pageHeightMeters / 2) / 111320;
                const lngDelta = (params.pageWidthMeters / 2) / (111320 * Math.cos(center.lat * Math.PI / 180));
                
                this.map.addSource("page-0", {
                    type: "geojson",
                    data: {
                        type: "Feature",
                        properties: {},
                        geometry: {
                            type: "Polygon",
                            coordinates: [[
                                [center.lng - lngDelta, center.lat - latDelta],
                                [center.lng + lngDelta, center.lat - latDelta],
                                [center.lng + lngDelta, center.lat + latDelta],
                                [center.lng - lngDelta, center.lat + latDelta],
                                [center.lng - lngDelta, center.lat - latDelta]
                            ]]
                        }
                    }
                });
                this.map.addLayer({
                    id: "page-0",
                    type: "line",
                    source: "page-0",
                    paint: {
                        "line-color": "red",
                        "line-width": 2,
                        "line-dasharray": [2, 2]
                    }
                });
            }
        }
    }

    private getLatlngs(routeData: any): LatLngAltTime[] {
        let latLngs: LatLngAltTime[] = [];
        for (const segment of routeData.segments) {
            latLngs = latLngs.concat(segment.latlngs);
        }
        for (const markers of routeData.markers) {
            latLngs.push(markers.latlng);
        }
        return latLngs;
    }
}
