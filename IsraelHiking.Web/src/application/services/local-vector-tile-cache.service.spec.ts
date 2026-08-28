import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TestBed } from "@angular/core/testing";
import { provideHttpClient, withInterceptorsFromDi } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { provideStore, Store } from "@ngxs/store";
import Dexie from "dexie";

import { LocalVectorTileCacheService } from "./local-vector-tile-cache.service";
import { LoggingService } from "./logging.service";
import { OfflineReducer } from "../reducers/offline.reducer";
import type { ApplicationState } from "../models";

describe("LocalVectorTileCacheService", () => {
    let service: LocalVectorTileCacheService;
    let httpTestingController: HttpTestingController;
    let store: Store;

    beforeEach(async () => {
        TestBed.configureTestingModule({
            providers: [
                LocalVectorTileCacheService,
                provideHttpClient(withInterceptorsFromDi()),
                provideHttpClientTesting(),
                provideStore([OfflineReducer]),
                {
                    provide: LoggingService,
                    useValue: {
                        debug: () => {},
                        info: () => {},
                        warning: () => {},
                        error: () => {}
                    }
                }
            ]
        });

        service = TestBed.inject(LocalVectorTileCacheService);
        httpTestingController = TestBed.inject(HttpTestingController);
        store = TestBed.inject(Store);

        await Dexie.delete("LocalTileCache");
    });

    afterEach(async () => {
        httpTestingController.verify();
        await Dexie.delete("LocalTileCache");
    });

    describe("Tile-region matching", () => {
        it("Requested tile at zoom below 15 intersects a saved region", () => {
            vi.spyOn(store, "selectSnapshot").mockImplementation(((selector: (state: ApplicationState) => unknown) => selector({
                offlineState: {
                    isLocalVectorTileCacheEnabled: true,
                    localVectorTileCacheRegions: [
                        service.createMapTileRegion(100, 100, "Test Region")
                    ]
                }
            } as unknown as ApplicationState)) as never);
            const keys = service.getRegionTileKeysForTile(14, 50, 50);
            expect(keys).toContain("100-100");
        });

        it("Requested tile at zoom 15 matches exactly", () => {
            vi.spyOn(store, "selectSnapshot").mockImplementation(((selector: (state: ApplicationState) => unknown) => selector({
                offlineState: {
                    isLocalVectorTileCacheEnabled: true,
                    localVectorTileCacheRegions: [
                        service.createMapTileRegion(100, 100, "Test Region")
                    ]
                }
            } as unknown as ApplicationState)) as never);
            const keys = service.getRegionTileKeysForTile(15, 100, 100);
            expect(keys).toContain("100-100");
        });

        it("Requested tile outside saved regions is not cacheable", () => {
            vi.spyOn(store, "selectSnapshot").mockImplementation(((selector: (state: ApplicationState) => unknown) => selector({
                offlineState: {
                    isLocalVectorTileCacheEnabled: true,
                    localVectorTileCacheRegions: [
                        service.createMapTileRegion(100, 100, "Test Region")
                    ]
                }
            } as unknown as ApplicationState)) as never);
            const keys = service.getRegionTileKeysForTile(15, 101, 100);
            expect(keys.length).toBe(0);
        });

        it("Overlapping saved regions share tile records", () => {
            vi.spyOn(store, "selectSnapshot").mockImplementation(((selector: (state: ApplicationState) => unknown) => selector({
                offlineState: {
                    isLocalVectorTileCacheEnabled: true,
                    localVectorTileCacheRegions: [
                        service.createMapTileRegion(100, 100, "Region A"),
                        service.createMapTileRegion(100, 100, "Region B")
                    ]
                }
            } as unknown as ApplicationState)) as never);
            const keys = service.getRegionTileKeysForTile(15, 100, 100);
            expect(keys).toContain("100-100");
        });
    });

    describe("slice:// behavior", () => {
        it("Cached tile is returned without network", async () => {
            vi.spyOn(store, "selectSnapshot").mockImplementation(((selector: (state: ApplicationState) => unknown) => selector({
                offlineState: {
                    isLocalVectorTileCacheEnabled: true,
                    localVectorTileCacheRegions: [
                        service.createMapTileRegion(100, 100, "Test Region")
                    ]
                }
            } as unknown as ApplicationState)) as never);

            const db = new Dexie("LocalTileCache");
            db.version(1).stores({ tiles: "url, z, x, y, type, sourceType, *regionTileKeys" });
            const buffer = new ArrayBuffer(10);
            await db.table("tiles").put({
                url: "https://israelhiking.osm.org.il/Israel/15/100/100.pbf",
                z: 15, x: 100, y: 100,
                type: "Israel", sourceType: "vector",
                regionTileKeys: ["100-100"],
                data: buffer,
                size: 10,
                fetchedAt: new Date().toISOString()
            });

            const downloadMock = vi.fn().mockResolvedValue({ data: new ArrayBuffer(5) });
            const result = await service.getOrDownloadTileBySliceUrl("slice://israelhiking.osm.org.il/Israel/15/100/100.pbf", downloadMock);

            expect(result?.fromCache).toBe(true);
            expect(result?.data).toEqual(buffer);
            expect(downloadMock).not.toHaveBeenCalled();
        });

        it("Network tile is stored when requested inside a saved region", async () => {
            vi.spyOn(store, "selectSnapshot").mockImplementation(((selector: (state: ApplicationState) => unknown) => selector({
                offlineState: {
                    isLocalVectorTileCacheEnabled: true,
                    localVectorTileCacheRegions: [
                        service.createMapTileRegion(100, 100, "Test Region")
                    ]
                }
            } as unknown as ApplicationState)) as never);

            const buffer = new ArrayBuffer(10);
            const downloadMock = vi.fn().mockResolvedValue({ data: buffer });
            const result = await service.getOrDownloadTileBySliceUrl("slice://israelhiking.osm.org.il/Israel/15/100/100.pbf", downloadMock);

            expect(result?.fromCache).toBeFalsy();
            expect(result?.data).toEqual(buffer);
            expect(downloadMock).toHaveBeenCalled();

            const db = new Dexie("LocalTileCache");
            db.version(1).stores({ tiles: "url, z, x, y, type, sourceType, *regionTileKeys" });
            const entry = await db.table("tiles").get("https://israelhiking.osm.org.il/Israel/15/100/100.pbf");
            expect(entry.data).toEqual(buffer);
            expect(entry.regionTileKeys).toContain("100-100");
        });

        it("Network failure returns cached tile if available", async () => {
            vi.spyOn(store, "selectSnapshot").mockImplementation(((selector: (state: ApplicationState) => unknown) => selector({
                offlineState: {
                    isLocalVectorTileCacheEnabled: true,
                    localVectorTileCacheRegions: [
                        service.createMapTileRegion(100, 100, "Test Region")
                    ]
                }
            } as unknown as ApplicationState)) as never);
            const db = new Dexie("LocalTileCache");
            db.version(1).stores({ tiles: "url, z, x, y, type, sourceType, *regionTileKeys" });
            const buffer = new ArrayBuffer(10);
            await db.table("tiles").put({
                url: "https://israelhiking.osm.org.il/Israel/15/100/100.pbf",
                z: 15, x: 100, y: 100,
                type: "Israel", sourceType: "vector",
                regionTileKeys: ["100-100"],
                data: buffer,
                size: 10,
                fetchedAt: new Date().toISOString()
            });

            const downloadMock = vi.fn().mockRejectedValue(new Error("Network failure"));
            const result = await service.getOrDownloadTileBySliceUrl("slice://israelhiking.osm.org.il/Israel/15/100/100.pbf", downloadMock);

            expect(result?.fromCache).toBe(true);
            expect(result?.data).toEqual(buffer);
        });

        it("Outside saved regions, caching behavior is skipped", async () => {
            vi.spyOn(store, "selectSnapshot").mockImplementation(((selector: (state: ApplicationState) => unknown) => selector({
                offlineState: {
                    isLocalVectorTileCacheEnabled: true,
                    localVectorTileCacheRegions: [
                        service.createMapTileRegion(100, 100, "Test Region")
                    ]
                }
            } as unknown as ApplicationState)) as never);

            const buffer = new ArrayBuffer(10);
            const downloadMock = vi.fn().mockResolvedValue({ data: buffer });
            const result = await service.getOrDownloadTileBySliceUrl("slice://israelhiking.osm.org.il/Israel/15/101/100.pbf", downloadMock);

            expect(result).toBeNull();
            expect(downloadMock).not.toHaveBeenCalled();
        });
    });

    describe("Style caching", () => {
        it("Should store and retrieve a style from the cache", async () => {
            const url = "https://raw.githubusercontent.com/IsraelHikingMap/VectorMap/master/Styles/mapeak-hike.json";
            const styleText = "{\"version\": 8}";

            await service.storeStyle(url, styleText);
            const retrieved = await service.getStyle(url);

            expect(retrieved).toBe(styleText);
        });

        it("Should return null if style is not cached", async () => {
            const url = "https://nonexistent/style.json";
            const retrieved = await service.getStyle(url);
            expect(retrieved).toBeNull();
        });
    });
});
