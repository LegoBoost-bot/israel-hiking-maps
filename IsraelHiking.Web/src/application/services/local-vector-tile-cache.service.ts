import { inject, Injectable } from "@angular/core";
import { featureCollection } from "@turf/helpers";
import circle from "@turf/circle";
import { v4 as uuidv4 } from "uuid";
import type { Immutable } from "immer";

import { SpatialService } from "./spatial.service";
import { SelectedRouteService } from "./selected-route.service";
import type { LatLngAltTime, LocalVectorTileCacheRegion, RouteData } from "../models";

export const LOCAL_VECTOR_TILE_CACHE_ZOOM = 15;

@Injectable()
export class LocalVectorTileCacheService {

    /** Buffer around a route when computing the cached map area. */
    public static readonly ROUTE_BUFFER_METERS = 1000;

    private readonly selectedRouteService = inject(SelectedRouteService);

    public getTileKey(tileX: number, tileY: number): string {
        return `${tileX}-${tileY}`;
    }

    public parseTileKey(tileKey: string): { tileX: number; tileY: number } {
        const [tileX, tileY] = tileKey.split("-").map(Number);
        return { tileX, tileY };
    }

    public getTileKeysForMapClick(latlng: LatLngAltTime): string[] {
        const tile = SpatialService.toTile(latlng, LOCAL_VECTOR_TILE_CACHE_ZOOM);
        return [this.getTileKey(Math.floor(tile.x), Math.floor(tile.y))];
    }

    public getTileKeysForRoute(route: Immutable<RouteData> | RouteData, bufferMeters = LocalVectorTileCacheService.ROUTE_BUFFER_METERS): string[] {
        const latlngs = this.selectedRouteService.getLatlngs(route);
        if (latlngs.length === 0) {
            return [];
        }
        const circles = latlngs.map(latlng => circle(SpatialService.toCoordinate(latlng), bufferMeters, {
            units: "meters",
            steps: 8
        }));
        const bounds = SpatialService.getBoundsForFeatureCollection(featureCollection(circles));
        return SpatialService.getTileKeysInBounds(bounds, LOCAL_VECTOR_TILE_CACHE_ZOOM);
    }

    public createMapTileRegion(tileX: number, tileY: number, label?: string): LocalVectorTileCacheRegion {
        const tileKey = this.getTileKey(tileX, tileY);
        return {
            id: uuidv4(),
            source: "mapTile",
            label: label ?? tileKey,
            tileKeys: [tileKey],
            addedAt: new Date().toISOString()
        };
    }

    public createRouteRegion(route: Immutable<RouteData> | RouteData, bufferMeters = LocalVectorTileCacheService.ROUTE_BUFFER_METERS): LocalVectorTileCacheRegion | null {
        const tileKeys = this.getTileKeysForRoute(route, bufferMeters);
        if (tileKeys.length === 0) {
            return null;
        }
        return {
            id: uuidv4(),
            source: "route",
            label: route.name,
            tileKeys,
            routeId: route.id,
            addedAt: new Date().toISOString(),
            bufferMeters
        };
    }

    public getAllTileKeys(regions: LocalVectorTileCacheRegion[]): string[] {
        const keys = new Set<string>();
        for (const region of regions) {
            for (const tileKey of region.tileKeys) {
                keys.add(tileKey);
            }
        }
        return [...keys];
    }
}
