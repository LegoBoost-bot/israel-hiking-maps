import { EventEmitter, inject, Injectable } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { featureCollection } from "@turf/helpers";
import circle from "@turf/circle";
import { v4 as uuidv4 } from "uuid";
import type { Immutable } from "immer";
import Dexie from "dexie";
import { firstValueFrom } from "rxjs";
import { timeout } from "rxjs/operators";
import pLimit from "p-limit";
import type { RasterDEMSourceSpecification, StyleSpecification, VectorSourceSpecification } from "maplibre-gl";

import { SpatialService } from "./spatial.service";
import { LoggingService } from "./logging.service";
import { Urls } from "../urls";
import { Store } from "@ngxs/store";
import type { ApplicationState, LatLngAltTime, LocalVectorTileCacheRegion, RouteData } from "../models";

export const LOCAL_VECTOR_TILE_CACHE_ZOOM = 15;

export type LocalVectorTileCacheDownloadProgress = {
    regionId: string;
    label: string;
    completed: number;
    total: number;
    percent: number;
    status: "downloading" | "completed" | "error";
};

type LocalTileCacheEntry = {
    url: string;
    z: number;
    x: number;
    y: number;
    type: string;
    sourceType: "vector" | "raster-dem";
    size: number;
    fetchedAt: string;
    regionTileKeys: string[];
    data: ArrayBuffer;
};

type LocalTileCacheSource = {
    sourceType: "vector" | "raster-dem";
    type: string;
    template: string;
    minzoom: number;
    maxzoom: number;
};

type ParsedTileUrl = {
    url: string;
    z: number;
    x: number;
    y: number;
    type: string;
    sourceType: "vector" | "raster-dem";
};

@Injectable()
export class LocalVectorTileCacheService {

    /** Buffer around a route when computing the cached map area. */
    public static readonly ROUTE_BUFFER_METERS = 1000;

    private static readonly DB_NAME = "LocalTileCache";
    private static readonly TABLE_NAME = "tiles";
    private static readonly TERRAIN_DEM_SOURCE: LocalTileCacheSource = {
        sourceType: "raster-dem",
        type: "jaxa_terrarium0-11_v2",
        template: "https://global.israelhikingmap.workers.dev/jaxa_terrarium0-11_v2/{z}/{x}/{y}.webp",
        minzoom: 7,
        maxzoom: 11
    };

    public readonly downloadProgressChanged = new EventEmitter<LocalVectorTileCacheDownloadProgress>();

    private database: Dexie;
    private cacheableSourcesPromise: Promise<LocalTileCacheSource[]>;
    private downloadingRegionIds = new Set<string>();
    private progressByRegion = new Map<string, LocalVectorTileCacheDownloadProgress>();

    private readonly httpClient = inject(HttpClient);
    private readonly loggingService = inject(LoggingService);
    private readonly store = inject(Store);

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
        const latlngs = route ? route.segments.flatMap(s => s.latlngs) : [];
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

    public getAllTileKeys(regions: readonly { tileKeys: readonly string[] }[]): string[] {
        const keys = new Set<string>();
        for (const region of regions) {
            for (const tileKey of region.tileKeys) {
                keys.add(tileKey);
            }
        }
        return [...keys];
    }

    public getDownloadProgress(regionId: string): LocalVectorTileCacheDownloadProgress | null {
        return this.progressByRegion.get(regionId) ?? null;
    }

    public isDownloading(regionId: string): boolean {
        return this.downloadingRegionIds.has(regionId);
    }

    public async downloadRegion(region: LocalVectorTileCacheRegion): Promise<"downloaded" | "up-to-date" | "error"> {
        if (this.downloadingRegionIds.has(region.id)) {
            return "up-to-date";
        }
        this.downloadingRegionIds.add(region.id);
        try {
            const tasks = await this.getDownloadTasksForRegion(region);
            const total = tasks.length;
            let completed = 0;
            this.updateProgress(region, completed, total, "downloading");
            if (total === 0) {
                this.updateProgress(region, completed, total, "completed");
                return "up-to-date";
            }
            const limit = pLimit(4);
            let downloadedCount = 0;
            await Promise.all(tasks.map(task => limit(async () => {
                const cached = await this.getTileByUrl(task.url);
                if (cached == null) {
                    const data = await firstValueFrom(this.httpClient.get(task.url, { responseType: "arraybuffer" }).pipe(timeout(60000)));
                    await this.storeTile(task, data);
                    downloadedCount++;
                } else {
                    await this.addRegionReferences(task.url, task.regionTileKeys);
                }
                completed++;
                this.updateProgress(region, completed, total, "downloading");
            })));
            this.updateProgress(region, completed, total, "completed");
            return downloadedCount === 0 ? "up-to-date" : "downloaded";
        } catch (ex) {
            this.loggingService.error(`[Local Tile Cache] Failed downloading region ${region.id}: ${(ex as Error).message}`);
            const current = this.progressByRegion.get(region.id);
            this.updateProgress(region, current?.completed ?? 0, current?.total ?? 0, "error");
            return "error";
        } finally {
            this.downloadingRegionIds.delete(region.id);
        }
    }

    public async deleteRegion(region: LocalVectorTileCacheRegion): Promise<void> {
        const database = this.getDatabase();
        const table = database.table<LocalTileCacheEntry>(LocalVectorTileCacheService.TABLE_NAME);
        const regionTileKeys = new Set(region.tileKeys);
        const allOtherRegions = this.store.selectSnapshot((state: ApplicationState) => state.offlineState.localVectorTileCacheRegions)
            ?.filter(r => r.id !== region.id) ?? [];
        const allOtherTileKeys = new Set(this.getAllTileKeys(allOtherRegions));

        const entries = await table
            .filter(entry => entry.regionTileKeys.some(tileKey => regionTileKeys.has(tileKey)))
            .toArray();
        for (const entry of entries) {
            entry.regionTileKeys = entry.regionTileKeys.filter(tileKey => allOtherTileKeys.has(tileKey));
            if (entry.regionTileKeys.length === 0) {
                await table.delete(entry.url);
            } else {
                await table.put(entry);
            }
        }
        this.progressByRegion.delete(region.id);
    }

    public async storeStyle(url: string, styleText: string): Promise<void> {
        const normalizedUrl = this.normalizeTileUrl(url);
        const encoder = new TextEncoder();
        const data = encoder.encode(styleText).buffer;
        await this.getDatabase().table<LocalTileCacheEntry>(LocalVectorTileCacheService.TABLE_NAME).put({
            url: normalizedUrl,
            z: 0,
            x: 0,
            y: 0,
            type: "style",
            sourceType: "vector",
            size: data.byteLength,
            fetchedAt: new Date().toISOString(),
            regionTileKeys: ["style"],
            data
        });
    }

    public async getStyle(url: string): Promise<string | null> {
        const normalizedUrl = this.normalizeTileUrl(url);
        const cached = await this.getTileByUrl(normalizedUrl);
        if (cached == null) {
            return null;
        }
        const decoder = new TextDecoder("utf-8");
        return decoder.decode(cached);
    }


    public async getOrDownloadTileBySliceUrl(
        sliceUrl: string,
        download: () => Promise<{ data: ArrayBuffer; cacheControl?: string; expires?: string }>
    ): Promise<{ data: ArrayBuffer; cacheControl?: string; expires?: string; fromCache?: boolean } | null> {
        const parsed = this.parseTileUrl(sliceUrl);
        if (parsed == null || !this.isEnabled()) {
            return null;
        }
        const regionTileKeys = this.getRegionTileKeysForTile(parsed.z, parsed.x, parsed.y);
        if (regionTileKeys.length === 0) {
            return null;
        }
        const cached = await this.getTileByUrl(parsed.url);
        if (cached != null) {
            console.info(`[Local Tile Cache] Served from persistent cache: ${parsed.url}`);
            return { data: cached, fromCache: true };
        }
        const response = await download();
        await this.storeTile({
            ...parsed,
            regionTileKeys
        }, response.data);
        return response;
    }

    public getRegionTileKeysForTile(z: number, x: number, y: number): string[] {
        const regions = this.store.selectSnapshot((state: ApplicationState) => state.offlineState.localVectorTileCacheRegions) ?? [];
        const savedTileKeys = new Set(this.getAllTileKeys(regions));
        if (savedTileKeys.size === 0) {
            return [];
        }
        const matchingTileKeys: string[] = [];
        if (z <= LOCAL_VECTOR_TILE_CACHE_ZOOM) {
            const scale = Math.pow(2, LOCAL_VECTOR_TILE_CACHE_ZOOM - z);
            const minX = x * scale;
            const maxX = (x + 1) * scale - 1;
            const minY = y * scale;
            const maxY = (y + 1) * scale - 1;
            for (const tileKey of savedTileKeys) {
                const { tileX, tileY } = this.parseTileKey(tileKey);
                if (tileX >= minX && tileX <= maxX && tileY >= minY && tileY <= maxY) {
                    matchingTileKeys.push(tileKey);
                }
            }
            return matchingTileKeys;
        }
        const parentTile = SpatialService.getParentZoomTileCoordinates({ x, y }, z, LOCAL_VECTOR_TILE_CACHE_ZOOM);
        const tileKey = this.getTileKey(parentTile.tileX, parentTile.tileY);
        return savedTileKeys.has(tileKey) ? [tileKey] : [];
    }

    private updateProgress(region: LocalVectorTileCacheRegion, completed: number, total: number, status: LocalVectorTileCacheDownloadProgress["status"]) {
        const progress = {
            regionId: region.id,
            label: region.label,
            completed,
            total,
            percent: total === 0 ? 100 : completed / total * 100,
            status
        };
        this.progressByRegion.set(region.id, progress);
        this.downloadProgressChanged.emit(progress);
    }

    private async getDownloadTasksForRegion(region: LocalVectorTileCacheRegion): Promise<(ParsedTileUrl & { regionTileKeys: string[] })[]> {
        const sources = await this.getCacheableSources();
        const tasksByUrl = new Map<string, ParsedTileUrl & { regionTileKeys: string[] }>();
        for (const tileKey of region.tileKeys) {
            const { tileX, tileY } = this.parseTileKey(tileKey);
            for (const source of sources) {
                for (let z = source.minzoom; z <= source.maxzoom; z++) {
                    const { tileX: x, tileY: y } = SpatialService.getParentZoomTileCoordinates({ x: tileX, y: tileY }, LOCAL_VECTOR_TILE_CACHE_ZOOM, z);
                    const url = this.createTileUrl(source.template, z, x, y);
                    const existingTask = tasksByUrl.get(url);
                    if (existingTask != null) {
                        if (!existingTask.regionTileKeys.includes(tileKey)) {
                            existingTask.regionTileKeys.push(tileKey);
                        }
                        continue;
                    }
                    tasksByUrl.set(url, {
                        url,
                        z,
                        x,
                        y,
                        type: source.type,
                        sourceType: source.sourceType,
                        regionTileKeys: [tileKey]
                    });
                }
            }
        }
        return [...tasksByUrl.values()];
    }

    private async getCacheableSources(): Promise<LocalTileCacheSource[]> {
        if (this.cacheableSourcesPromise == null) {
            this.cacheableSourcesPromise = this.fetchCacheableSources();
        }
        return this.cacheableSourcesPromise;
    }

    private async fetchCacheableSources(): Promise<LocalTileCacheSource[]> {
        const sourcesByTemplate = new Map<string, LocalTileCacheSource>();
        for (const styleUrl of [Urls.HIKING_STYLE_ADDRESS, Urls.MTB_STYLE_ADDRESS]) {
            try {
                const styleText = await firstValueFrom(this.httpClient.get(styleUrl, { responseType: "text" }).pipe(timeout(10000)));
                await this.storeStyle(styleUrl, styleText);
                const style = JSON.parse(styleText) as StyleSpecification;
                for (const source of Object.values(style.sources ?? {})) {
                    if (source.type !== "vector" && source.type !== "raster-dem") {
                        continue;
                    }
                    const tileTemplate = (source as VectorSourceSpecification | RasterDEMSourceSpecification).tiles?.[0];
                    if (tileTemplate == null) {
                        continue;
                    }
                    const normalizedTemplate = this.normalizeTileUrl(tileTemplate);
                    const maxzoom = Math.min((source as VectorSourceSpecification | RasterDEMSourceSpecification).maxzoom ?? LOCAL_VECTOR_TILE_CACHE_ZOOM, LOCAL_VECTOR_TILE_CACHE_ZOOM);
                    const minzoom = Math.max((source as VectorSourceSpecification | RasterDEMSourceSpecification).minzoom ?? 0, 0);
                    sourcesByTemplate.set(normalizedTemplate, {
                        sourceType: source.type,
                        type: this.getSourceTypeFromTemplate(normalizedTemplate),
                        template: normalizedTemplate,
                        minzoom,
                        maxzoom
                    });
                }
            } catch (ex) {
                this.loggingService.warning(`[Local Tile Cache] Failed to load style ${styleUrl}: ${(ex as Error).message}`);
            }
        }
        sourcesByTemplate.set(LocalVectorTileCacheService.TERRAIN_DEM_SOURCE.template, LocalVectorTileCacheService.TERRAIN_DEM_SOURCE);
        return [...sourcesByTemplate.values()];
    }

    private getDatabase(): Dexie {
        if (this.database != null) {
            return this.database;
        }
        this.database = new Dexie(LocalVectorTileCacheService.DB_NAME);
        this.database.version(1).stores({
            [LocalVectorTileCacheService.TABLE_NAME]: "url, z, x, y, type, sourceType, *regionTileKeys"
        });
        return this.database;
    }

    private async getTileByUrl(url: string): Promise<ArrayBuffer | null> {
        const entry = await this.getDatabase().table<LocalTileCacheEntry>(LocalVectorTileCacheService.TABLE_NAME).get(url);
        return entry?.data ?? null;
    }

    private async storeTile(tile: ParsedTileUrl & { regionTileKeys: string[] }, data: ArrayBuffer): Promise<void> {
        await this.getDatabase().table<LocalTileCacheEntry>(LocalVectorTileCacheService.TABLE_NAME).put({
            ...tile,
            regionTileKeys: [...new Set(tile.regionTileKeys)],
            data,
            size: data.byteLength,
            fetchedAt: new Date().toISOString()
        });
    }

    private async addRegionReferences(url: string, regionTileKeys: string[]): Promise<void> {
        const table = this.getDatabase().table<LocalTileCacheEntry>(LocalVectorTileCacheService.TABLE_NAME);
        const entry = await table.get(url);
        if (entry == null) {
            return;
        }
        entry.regionTileKeys = [...new Set([...entry.regionTileKeys, ...regionTileKeys])];
        await table.put(entry);
    }

    private parseTileUrl(url: string): ParsedTileUrl | null {
        const normalizedUrl = this.normalizeTileUrl(url);
        const urlWithoutQuery = normalizedUrl.split("?")[0];
        const splitUrl = urlWithoutQuery.split("/");
        const yFileName = splitUrl[splitUrl.length - 1];
        const y = +(yFileName.split(".")[0]);
        const x = +splitUrl[splitUrl.length - 2];
        const z = +splitUrl[splitUrl.length - 3];
        if (isNaN(z) || isNaN(x) || isNaN(y)) {
            return null;
        }
        const extension = yFileName.split(".").pop()?.toLowerCase();
        if (!["mvt", "pbf", "webp", "png"].includes(extension)) {
            return null;
        }
        return {
            url: normalizedUrl,
            z,
            x,
            y,
            type: splitUrl[splitUrl.length - 4],
            sourceType: extension === "webp" || extension === "png" ? "raster-dem" : "vector"
        };
    }

    private normalizeTileUrl(url: string): string {
        return url.replace("slice://", "https://");
    }

    private createTileUrl(template: string, z: number, x: number, y: number): string {
        return template
            .replace("{z}", `${z}`)
            .replace("{x}", `${x}`)
            .replace("{y}", `${y}`);
    }

    private getSourceTypeFromTemplate(template: string): string {
        const splitUrl = template.split("?")[0].split("/");
        const zIndex = splitUrl.findIndex(value => value === "{z}");
        return zIndex <= 0 ? "unknown" : splitUrl[zIndex - 1];
    }

    private isEnabled(): boolean {
        const offlineState = this.store.selectSnapshot((state: ApplicationState) => state.offlineState);
        return offlineState.isLocalVectorTileCacheEnabled === true && (offlineState.localVectorTileCacheRegions?.length ?? 0) > 0;
    }
}
