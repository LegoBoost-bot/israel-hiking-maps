import { DecimalPipe } from "@angular/common";
import { Component, computed, inject, signal } from "@angular/core";
import { Store } from "@ngxs/store";
import { GeoJSONSourceComponent, LayerComponent, MapComponent } from "@maplibre/ngx-maplibre-gl";
import { type Map, type MapMouseEvent, LngLatBounds, type StyleSpecification } from "maplibre-gl";
import { MatButton } from "@angular/material/button";
import { MatProgressSpinner } from "@angular/material/progress-spinner";

import { AutomaticLayerPresentationComponent } from "../map/automatic-layer-presentation.component";
import { RoutesPathComponent } from "../map/routes-path.component";
import { AnalyticsDirective } from "../../directives/analytics.directive";
import { ResourcesService } from "../../services/resources.service";
import { DefaultStyleService } from "../../services/default-style.service";
import { LayersService } from "../../services/layers.service";
import {
    LOCAL_VECTOR_TILE_CACHE_ZOOM,
    LocalVectorTileCacheDownloadProgress,
    LocalVectorTileCacheService
} from "../../services/local-vector-tile-cache.service";
import { SpatialService } from "../../services/spatial.service";
import { SelectedRouteService } from "../../services/selected-route.service";
import { ToastService } from "../../services/toast.service";
import { DEFAULT_BASE_LAYERS, HIKING_MAP, MTB_MAP } from "../../reducers/initial-state";
import {
    AddLocalVectorTileCacheRegionAction,
    RemoveLocalVectorTileCacheRegionAction
} from "../../reducers/offline.reducer";
import type { ApplicationState, EditableLayer, LocalVectorTileCacheRegion } from "../../models";

@Component({
    selector: "local-tile-cache-management",
    templateUrl: "./local-tile-cache-management.component.html",
    imports: [MapComponent, AnalyticsDirective, MatButton, MatProgressSpinner, LayerComponent, GeoJSONSourceComponent, AutomaticLayerPresentationComponent, RoutesPathComponent, DecimalPipe]
})
export class LocalTileCacheManagementComponent {
    private readonly store = inject(Store);
    private readonly selectedRouteService = inject(SelectedRouteService);

    public mapStyle: StyleSpecification;
    public drawingRectangleGeoJson: GeoJSON.FeatureCollection = { features: [], type: "FeatureCollection" };
    public savedTilesGeoJson: GeoJSON.FeatureCollection = { features: [], type: "FeatureCollection" };
    public baseLayerData: EditableLayer;

    private isDrawing = false;
    private startPoint: { lng: number; lat: number } = null;
    private longPressTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly LONG_PRESS_DURATION = 1000;

    public readonly regions = signal<LocalVectorTileCacheRegion[]>([]);
    public readonly progressByRegionId = signal<Record<string, LocalVectorTileCacheDownloadProgress>>({});
    public readonly routes = this.store.selectSignal((state: ApplicationState) => state.routes.present);
    public readonly cachedRoutesGeoJson = computed<GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.Point>>(() => {
        const routeIds = new Set(this.regions()
            .filter(region => region.source === "route" && region.routeId)
            .map(region => region.routeId));
        const features = this.routes()
            .filter(route => routeIds.has(route.id))
            .flatMap(route => this.selectedRouteService.createFeaturesForRoute(route));
        return {
            type: "FeatureCollection",
            features
        };
    });

    private map: Map;

    private readonly defaultStyleService = inject(DefaultStyleService);
    private readonly layersService = inject(LayersService);
    private readonly localVectorTileCacheService = inject(LocalVectorTileCacheService);
    private readonly toastService = inject(ToastService);
    public readonly resources = inject(ResourcesService);

    constructor() {
        this.mapStyle = this.defaultStyleService.getStyleWithPlaceholders();
        this.baseLayerData = this.layersService.selectedBaseLayer();
        if (this.baseLayerData.key !== HIKING_MAP && this.baseLayerData.key !== MTB_MAP) {
            this.baseLayerData = { ...DEFAULT_BASE_LAYERS[0] };
        }
        this.store.select((state: ApplicationState) => state.offlineState.localVectorTileCacheRegions)
            .subscribe(regions => {
                this.regions.set(regions.map(region => ({
                    ...region,
                    tileKeys: [...region.tileKeys]
                })));
                this.updateSavedTilesGeoJson();
            });
        this.localVectorTileCacheService.downloadProgressChanged.subscribe(progress => {
            this.progressByRegionId.update(progressByRegionId => ({
                ...progressByRegionId,
                [progress.regionId]: progress
            }));
        });
    }

    public onMapMouseDown(event: MapMouseEvent) {
        this.startPoint = event.lngLat;
        this.longPressTimer = setTimeout(() => {
            this.isDrawing = true;
            this.map.dragPan.disable();
            this.updateDrawingRectangle(event.lngLat);
        }, this.LONG_PRESS_DURATION);
    }

    public onMapMouseMove(event: MapMouseEvent) {
        if (this.isDrawing) {
            this.updateDrawingRectangle(event.lngLat);
        } else if (this.startPoint && this.longPressTimer) {
            const distance = Math.sqrt(Math.pow(event.lngLat.lng - this.startPoint.lng, 2) + Math.pow(event.lngLat.lat - this.startPoint.lat, 2));
            if (distance > 0.001) {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
                this.startPoint = null;
            }
        }
    }

    public onMapMouseUp(event: MapMouseEvent) {
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
        if (this.isDrawing) {
            this.isDrawing = false;
            this.map.dragPan.enable();
            this.updateDrawingRectangle(event.lngLat);
            this.startPoint = null;
        }
    }

    private updateDrawingRectangle(endPoint: { lng: number; lat: number }) {
        if (!this.startPoint) return;
        const bounds = new LngLatBounds(this.startPoint, endPoint);
        this.drawingRectangleGeoJson = {
            type: "FeatureCollection",
            features: [{
                type: "Feature",
                geometry: {
                    type: "Polygon",
                    coordinates: [[
                        [bounds.getWest(), bounds.getNorth()],
                        [bounds.getEast(), bounds.getNorth()],
                        [bounds.getEast(), bounds.getSouth()],
                        [bounds.getWest(), bounds.getSouth()],
                        [bounds.getWest(), bounds.getNorth()]
                    ]]
                },
                properties: {}
            }]
        };
    }

    private cancelDrawing() {
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
            this.startPoint = null;
        }
    }

    public onMapLoad(map: Map) {
        this.map = map;
        this.map.getCanvas().style.cursor = "crosshair";
        this.map.on("dragstart", () => this.cancelDrawing());
        this.map.on("zoomstart", () => this.cancelDrawing());
        this.map.dragRotate.disable();
        this.map.touchZoomRotate.disableRotation();
        const location = this.store.selectSnapshot((state: ApplicationState) => state.locationState);
        this.map.flyTo({
            center: [location.longitude, location.latitude],
            zoom: LOCAL_VECTOR_TILE_CACHE_ZOOM - 1
        });
        this.updateSavedTilesGeoJson();
    }

    public async addSelectedRectangleArea() {
        if (this.drawingRectangleGeoJson.features.length === 0) {
            return;
        }
        const bounds = SpatialService.getBoundsForFeatureCollection(this.drawingRectangleGeoJson);
        const tileKeys = SpatialService.getTileKeysInBounds(bounds, LOCAL_VECTOR_TILE_CACHE_ZOOM);
        const region = this.localVectorTileCacheService.createRectangleRegion(tileKeys);
        this.store.dispatch(new AddLocalVectorTileCacheRegionAction(region));
        this.drawingRectangleGeoJson = { type: "FeatureCollection", features: [] };
        await this.downloadRegion(region);
    }

    public async removeRegion(regionId: string) {
        const region = this.regions().find(r => r.id === regionId);
        this.store.dispatch(new RemoveLocalVectorTileCacheRegionAction(regionId));
        if (region != null) {
            await this.localVectorTileCacheService.deleteRegion(region);
            this.progressByRegionId.update(progressByRegionId => {
                const updatedProgress = { ...progressByRegionId };
                delete updatedProgress[regionId];
                return updatedProgress;
            });
        }
    }

    public getRouteLabel(region: LocalVectorTileCacheRegion): string {
        return this.routes().find(route => route.id === region.routeId)?.name ?? region.label;
    }

    public getProgress(regionId: string): LocalVectorTileCacheDownloadProgress | null {
        return this.progressByRegionId()[regionId] ?? this.localVectorTileCacheService.getDownloadProgress(regionId);
    }

    public isDownloading(regionId: string): boolean {
        return this.localVectorTileCacheService.isDownloading(regionId);
    }

    public async retryDownload(region: LocalVectorTileCacheRegion) {
        await this.downloadRegion(region);
    }

    private async downloadRegion(region: LocalVectorTileCacheRegion) {
        const status = await this.localVectorTileCacheService.downloadRegion(region);
        switch (status) {
            case "downloaded":
                this.toastService.success(this.resources.downloadFinishedSuccessfully);
                break;
            case "error":
                this.toastService.warning(this.resources.unexpectedErrorPleaseTryAgainLater);
                break;
        }
    }

    private updateSavedTilesGeoJson() {
        const features: GeoJSON.Feature[] = [];
        for (const region of this.regions()) {
            if (region.tileKeys.length === 0) continue;
            if (region.source === "mapTile") {
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (const tileKey of region.tileKeys) {
                    const { tileX, tileY } = this.localVectorTileCacheService.parseTileKey(tileKey);
                    minX = Math.min(minX, tileX);
                    minY = Math.min(minY, tileY);
                    maxX = Math.max(maxX, tileX);
                    maxY = Math.max(maxY, tileY);
                }
                const feature = this.tileCoordinatesToPolygon(minX, minY, maxX - minX + 1, maxY - minY + 1, "");
                feature.properties.color = "teal";
                features.push(feature);
            } else {
                for (const tileKey of region.tileKeys) {
                    const { tileX, tileY } = this.localVectorTileCacheService.parseTileKey(tileKey);
                    const feature = this.tileCoordinatesToPolygon(tileX, tileY, 1, 1, "");
                    feature.properties.color = "teal";
                    features.push(feature);
                }
            }
        }
        this.savedTilesGeoJson = {
            type: "FeatureCollection",
            features
        };
    }

    private tileCoordinatesToPolygon(tileX: number, tileY: number, width = 1, height = 1, label = ""): GeoJSON.Feature {
        return {
            type: "Feature",
            geometry: {
                type: "Polygon",
                coordinates: [
                    [
                        SpatialService.toCoordinate(SpatialService.fromTile({ x: tileX, y: tileY }, LOCAL_VECTOR_TILE_CACHE_ZOOM)),
                        SpatialService.toCoordinate(SpatialService.fromTile({ x: tileX + width, y: tileY }, LOCAL_VECTOR_TILE_CACHE_ZOOM)),
                        SpatialService.toCoordinate(SpatialService.fromTile({ x: tileX + width, y: tileY + height }, LOCAL_VECTOR_TILE_CACHE_ZOOM)),
                        SpatialService.toCoordinate(SpatialService.fromTile({ x: tileX, y: tileY + height }, LOCAL_VECTOR_TILE_CACHE_ZOOM)),
                        SpatialService.toCoordinate(SpatialService.fromTile({ x: tileX, y: tileY }, LOCAL_VECTOR_TILE_CACHE_ZOOM))
                    ]
                ]
            },
            properties: { label }
        };
    }
}
