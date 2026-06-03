import { Component, computed, inject, signal } from "@angular/core";
import { Store } from "@ngxs/store";
import { GeoJSONSourceComponent, LayerComponent, MapComponent } from "@maplibre/ngx-maplibre-gl";
import { type Map, type MapMouseEvent, MercatorCoordinate, type StyleSpecification } from "maplibre-gl";
import { MatButton } from "@angular/material/button";

import { AutomaticLayerPresentationComponent } from "../map/automatic-layer-presentation.component";
import { RoutesPathComponent } from "../map/routes-path.component";
import { AnalyticsDirective } from "../../directives/analytics.directive";
import { ResourcesService } from "../../services/resources.service";
import { DefaultStyleService } from "../../services/default-style.service";
import { LayersService } from "../../services/layers.service";
import { LOCAL_VECTOR_TILE_CACHE_ZOOM, LocalVectorTileCacheService } from "../../services/local-vector-tile-cache.service";
import { SpatialService } from "../../services/spatial.service";
import { SelectedRouteService } from "../../services/selected-route.service";
import { DEFAULT_BASE_LAYERS, HIKING_MAP, MTB_MAP } from "../../reducers/initial-state";
import {
    AddLocalVectorTileCacheRegionAction,
    RemoveLocalVectorTileCacheRegionAction
} from "../../reducers/offline.reducer";
import type { ApplicationState, EditableLayer, LocalVectorTileCacheRegion } from "../../models";

@Component({
    selector: "local-tile-cache-management",
    templateUrl: "./local-tile-cache-management.component.html",
    imports: [MapComponent, AnalyticsDirective, MatButton, LayerComponent, GeoJSONSourceComponent, AutomaticLayerPresentationComponent, RoutesPathComponent]
})
export class LocalTileCacheManagementComponent {
    private readonly store = inject(Store);
    private readonly selectedRouteService = inject(SelectedRouteService);

    public mapStyle: StyleSpecification;
    public selectedTileGeoJson: GeoJSON.FeatureCollection = { features: [], type: "FeatureCollection" };
    public savedTilesGeoJson: GeoJSON.FeatureCollection = { features: [], type: "FeatureCollection" };
    public baseLayerData: EditableLayer;
    public selectedTileXY: { tileX: number; tileY: number } = null;

    public readonly regions = signal<LocalVectorTileCacheRegion[]>([]);
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
    public readonly resources = inject(ResourcesService);

    constructor() {
        this.mapStyle = this.defaultStyleService.getStyleWithPlaceholders();
        this.baseLayerData = this.layersService.getSelectedBaseLayer();
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
                this.updateSelectedTileGeoJson();
            });
    }

    public onMapClick(event: MapMouseEvent) {
        const tileCount = Math.pow(2, LOCAL_VECTOR_TILE_CACHE_ZOOM);
        const mercator = MercatorCoordinate.fromLngLat(event.lngLat);
        const tileX = Math.floor(mercator.x * tileCount);
        const tileY = Math.floor(mercator.y * tileCount);
        this.selectedTileXY = { tileX, tileY };
        this.updateSelectedTileGeoJson();
        this.map?.flyTo({
            center: SpatialService.toCoordinate(SpatialService.fromTile({ x: tileX + 0.5, y: tileY + 0.5 }, LOCAL_VECTOR_TILE_CACHE_ZOOM)),
            zoom: LOCAL_VECTOR_TILE_CACHE_ZOOM - 1
        });
    }

    public onMapLoad(map: Map) {
        this.map = map;
        this.map.dragRotate.disable();
        this.map.touchZoomRotate.disableRotation();
        const location = this.store.selectSnapshot((state: ApplicationState) => state.locationState);
        this.map.flyTo({
            center: [location.longitude, location.latitude],
            zoom: LOCAL_VECTOR_TILE_CACHE_ZOOM - 1
        });
        this.updateSavedTilesGeoJson();
    }

    public addSelectedMapTile() {
        if (!this.selectedTileXY) {
            return;
        }
        const region = this.localVectorTileCacheService.createMapTileRegion(
            this.selectedTileXY.tileX,
            this.selectedTileXY.tileY
        );
        this.store.dispatch(new AddLocalVectorTileCacheRegionAction(region));
        this.selectedTileXY = null;
        this.updateSelectedTileGeoJson();
    }

    public removeRegion(regionId: string) {
        this.store.dispatch(new RemoveLocalVectorTileCacheRegionAction(regionId));
    }

    public isTileAlreadySaved(): boolean {
        if (!this.selectedTileXY) {
            return false;
        }
        const tileKey = this.localVectorTileCacheService.getTileKey(this.selectedTileXY.tileX, this.selectedTileXY.tileY);
        return this.localVectorTileCacheService.getAllTileKeys(this.regions()).includes(tileKey);
    }

    public getRouteLabel(region: LocalVectorTileCacheRegion): string {
        return this.routes().find(route => route.id === region.routeId)?.name ?? region.label;
    }

    private updateSavedTilesGeoJson() {
        const savedTileKeys = new Set(this.localVectorTileCacheService.getAllTileKeys(this.regions()));
        const features: GeoJSON.Feature[] = [];
        for (const tileKey of savedTileKeys) {
            const { tileX, tileY } = this.localVectorTileCacheService.parseTileKey(tileKey);
            const feature = this.tileCoordinatesToPolygon(tileX, tileY);
            feature.properties.color = "teal";
            features.push(feature);
        }
        this.savedTilesGeoJson = {
            type: "FeatureCollection",
            features
        };
    }

    private updateSelectedTileGeoJson() {
        if (!this.selectedTileXY || this.isTileAlreadySaved()) {
            this.selectedTileGeoJson = { type: "FeatureCollection", features: [] };
            return;
        }
        const { tileX, tileY } = this.selectedTileXY;
        this.selectedTileGeoJson = {
            type: "FeatureCollection",
            features: [this.tileCoordinatesToPolygon(tileX, tileY, this.resources.localVectorTileCacheAddMapArea)]
        };
    }

    private tileCoordinatesToPolygon(tileX: number, tileY: number, label = ""): GeoJSON.Feature {
        return {
            type: "Feature",
            geometry: {
                type: "Polygon",
                coordinates: [
                    [
                        SpatialService.toCoordinate(SpatialService.fromTile({ x: tileX, y: tileY }, LOCAL_VECTOR_TILE_CACHE_ZOOM)),
                        SpatialService.toCoordinate(SpatialService.fromTile({ x: tileX + 1, y: tileY }, LOCAL_VECTOR_TILE_CACHE_ZOOM)),
                        SpatialService.toCoordinate(SpatialService.fromTile({ x: tileX + 1, y: tileY + 1 }, LOCAL_VECTOR_TILE_CACHE_ZOOM)),
                        SpatialService.toCoordinate(SpatialService.fromTile({ x: tileX, y: tileY + 1 }, LOCAL_VECTOR_TILE_CACHE_ZOOM)),
                        SpatialService.toCoordinate(SpatialService.fromTile({ x: tileX, y: tileY }, LOCAL_VECTOR_TILE_CACHE_ZOOM))
                    ]
                ]
            },
            properties: { label }
        };
    }
}
