import { inject, Injectable } from "@angular/core";
import { Map as MapLibreMap } from "maplibre-gl";
import jsPDF from "jspdf";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { Store } from "@ngxs/store";
import { MapService } from "./map.service";
import { RunningContextService } from "./running-context.service";
import { SpatialService } from "./spatial.service";
import { RouteData, LatLngAltTime, ApplicationState } from "../models";
import { ChangeRouteStateAction } from "../reducers/routes.reducer";

@Injectable()
export class PrintService {
    private readonly mapService = inject(MapService);
    private readonly runningContextService = inject(RunningContextService);
    private readonly store = inject(Store);

    public getPagesCount(
        scale: "fit" | "1:50000" | "1:25000" | "custom",
        customScale: number,
        orientation: "portrait" | "landscape" | "auto",
        bounds: { southWest: { lat: number, lng: number }, northEast: { lat: number, lng: number } }
    ): number {
        const params = this.getPrintParams(scale, customScale, orientation, bounds);
        return params.cols * params.rows;
    }

    public getPrintParams(
        scale: "fit" | "1:50000" | "1:25000" | "custom",
        customScale: number,
        orientation: "portrait" | "landscape" | "auto",
        bounds: { southWest: { lat: number, lng: number }, northEast: { lat: number, lng: number } },
        splitToPages = true
    ) {
        const scaleValue = scale === "fit" ? 25000 : (scale === "custom" ? customScale : (scale === "1:50000" ? 50000 : 25000));
        
        const totalWidthMeters = SpatialService.getDistanceInMeters({ lat: bounds.southWest.lat, lng: bounds.southWest.lng, alt: 0 }, { lat: bounds.southWest.lat, lng: bounds.northEast.lng, alt: 0 });
        const totalHeightMeters = SpatialService.getDistanceInMeters({ lat: bounds.southWest.lat, lng: bounds.southWest.lng, alt: 0 }, { lat: bounds.northEast.lat, lng: bounds.southWest.lng, alt: 0 });

        let isLandscape: boolean;
        if (orientation === "auto") {
            const portraitParams = this.calculateTiling(false, totalWidthMeters, totalHeightMeters, scaleValue, splitToPages);
            const landscapeParams = this.calculateTiling(true, totalWidthMeters, totalHeightMeters, scaleValue, splitToPages);

            const portraitPages = portraitParams.cols * portraitParams.rows;
            const landscapePages = landscapeParams.cols * landscapeParams.rows;

            if (landscapePages < portraitPages) {
                isLandscape = true;
            } else if (portraitPages < landscapePages) {
                isLandscape = false;
            } else {
                // Tiebreaker: choose orientation with largest minimum margin (least "excess" space)
                const portraitMargin = Math.min(portraitParams.shiftX, portraitParams.shiftY);
                const landscapeMargin = Math.min(landscapeParams.shiftX, landscapeParams.shiftY);
                isLandscape = landscapeMargin >= portraitMargin;
            }
        } else {
            isLandscape = orientation === "landscape";
        }

        return this.calculateTiling(isLandscape, totalWidthMeters, totalHeightMeters, scaleValue, splitToPages);
    }

    private calculateTiling(
        isLandscape: boolean,
        totalWidthMeters: number,
        totalHeightMeters: number,
        scaleValue: number,
        splitToPages: boolean
    ) {
        const marginMm = 10;
        const pageMmWidth = (isLandscape ? 297 : 210) - 2 * marginMm;
        const pageMmHeight = (isLandscape ? 210 : 297) - 2 * marginMm;
        const overlapMm = 15;
        
        const pageWidthMeters = (pageMmWidth * scaleValue) / 1000;
        const pageHeightMeters = (pageMmHeight * scaleValue) / 1000;
        
        const cols = splitToPages ? Math.ceil((totalWidthMeters - overlapMm * scaleValue / 1000) / (pageWidthMeters - overlapMm * scaleValue / 1000)) : 1;
        const rows = splitToPages ? Math.ceil((totalHeightMeters - overlapMm * scaleValue / 1000) / (pageHeightMeters - overlapMm * scaleValue / 1000)) : 1;
        
        const shiftX = (((cols * (pageWidthMeters - overlapMm * scaleValue / 1000) + overlapMm * scaleValue / 1000) - totalWidthMeters) / 2);
        const shiftY = (((rows * (pageHeightMeters - overlapMm * scaleValue / 1000) + overlapMm * scaleValue / 1000) - totalHeightMeters) / 2);

        const dpi = 300;
        const canvasWidth = Math.round(pageMmWidth * dpi / 25.4);
        const canvasHeight = Math.round(pageMmHeight * dpi / 25.4);
        
        return {
            marginMm,
            pageMmWidth,
            pageMmHeight,
            overlapMm,
            pageWidthMeters,
            pageHeightMeters,
            totalWidthMeters,
            totalHeightMeters,
            cols,
            rows,
            shiftX,
            shiftY,
            isLandscape,
            scaleValue,
            canvasWidth,
            canvasHeight
        };
    }

    public async export(
        format: "pdf" | "png",
        scale: "fit" | "1:50000" | "1:25000" | "custom",
        customScale: number,
        orientation: "portrait" | "landscape" | "auto",
        route: RouteData | undefined,
        mode: "view" | "all" | "route",
        includeHillshade: boolean,
        splitToPages: boolean,
        excludedRouteIds: string[] = []
    ) {
        const map = this.mapService.map;
        if (!map) {
            return;
        }

        const originalRouteStates = new Map<string, string>();
        const allRoutes = this.store.selectSnapshot((s: ApplicationState) => s.routes.present);
        
        const hillshadeLayerIds: { id: string, visibility: string }[] = [];
        if (!includeHillshade) {
            const layers = map.getStyle().layers;
            for (const layer of layers) {
                if (layer.type === "hillshade") {
                    hillshadeLayerIds.push({ id: layer.id, visibility: map.getLayoutProperty(layer.id, "visibility") });
                    map.setLayoutProperty(layer.id, "visibility", "none");
                }
            }
        }
        
        if (mode === "route" && route) {
            for (const r of allRoutes) {
                originalRouteStates.set(r.id, r.state);
                if (r.id !== route.id && r.state !== "Hidden") {
                    this.store.dispatch(new ChangeRouteStateAction(r.id, "Hidden"));
                }
            }
        } else if (mode === "all") {
            for (const r of allRoutes) {
                if (excludedRouteIds.includes(r.id)) {
                    originalRouteStates.set(r.id, r.state);
                    this.store.dispatch(new ChangeRouteStateAction(r.id, "Hidden"));
                }
            }
        }
        
        const latlngs: LatLngAltTime[] = [];
        if (mode === "route" && route) {
            latlngs.push(...this.getLatlngs(route));
        } else if (mode === "all") {
            const mapBounds = this.mapService.getMapBounds();
            for (const r of allRoutes.filter(r => r.state !== "Hidden" && !excludedRouteIds.includes(r.id))) {
                const routeLatlngs = this.getLatlngs(r);
                const isAnyPointInViewport = routeLatlngs.some(pt => {
                    return pt.lng >= mapBounds.southWest.lng && pt.lng <= mapBounds.northEast.lng &&
                        pt.lat >= mapBounds.southWest.lat && pt.lat <= mapBounds.northEast.lat;
                });
                if (isAnyPointInViewport) {
                    latlngs.push(...routeLatlngs);
                }
            }
        }

        const bounds = latlngs.length > 0 ? SpatialService.getBounds(latlngs) : this.mapService.getMapBounds();
        
        if (format === "png") {
            await this.exportPng(bounds);
        } else {
            await this.exportPdf(bounds, scale, customScale, orientation, splitToPages);
        }

        if (route || mode === "all") {
            for (const [id, state] of originalRouteStates) {
                this.store.dispatch(new ChangeRouteStateAction(id, state as any));
            }
        }

        for (const hillshadeLayer of hillshadeLayerIds) {
            map.setLayoutProperty(hillshadeLayer.id, "visibility", hillshadeLayer.visibility as any);
        }
    }

    private async exportPng(bounds: { southWest: { lat: number, lng: number }, northEast: { lat: number, lng: number } }) {
        const map = this.mapService.map!;
        
        const container = map.getContainer();
        const originalWidth = container.style.width;
        const originalHeight = container.style.height;

        const widthMeters = SpatialService.getDistanceInMeters({ lat: bounds.southWest.lat, lng: bounds.southWest.lng, alt: 0 }, { lat: bounds.southWest.lat, lng: bounds.northEast.lng, alt: 0 });
        const heightMeters = SpatialService.getDistanceInMeters({ lat: bounds.southWest.lat, lng: bounds.southWest.lng, alt: 0 }, { lat: bounds.northEast.lat, lng: bounds.southWest.lng, alt: 0 });
        
        const aspectRatio = widthMeters / heightMeters;
        const baseSize = 1024;
        
        const exportWidth = aspectRatio >= 1 ? baseSize : Math.round(baseSize * aspectRatio);
        const exportHeight = aspectRatio >= 1 ? Math.round(baseSize / aspectRatio) : baseSize;

        container.style.width = `${exportWidth}px`;
        container.style.height = `${exportHeight}px`;
        map.resize();

        await this.mapService.fitBounds(bounds, 50);
        await this.waitForIdle(map);
        
        const dataUrl = map.getCanvas().toDataURL("image/png");
        const fileName = `map_${new Date().getTime()}.png`;

        container.style.width = originalWidth;
        container.style.height = originalHeight;
        map.resize();

        if (this.runningContextService.isCapacitor) {
            const savedFile = await Filesystem.writeFile({
                path: fileName,
                data: dataUrl.split(",")[1],
                directory: Directory.Cache
            });
            await Share.share({ url: savedFile.uri });
        } else {
            const link = document.createElement("a");
            link.href = dataUrl;
            link.download = fileName;
            link.click();
        }
    }

    private async exportPdf(
        bounds: { southWest: { lat: number, lng: number }, northEast: { lat: number, lng: number } },
        scale: "fit" | "1:50000" | "1:25000" | "custom",
        customScale: number,
        orientation: "portrait" | "landscape" | "auto",
        splitToPages: boolean
    ) {
        const map = this.mapService.map!;
        const container = map.getContainer();
        const originalWidth = container.style.width;
        const originalHeight = container.style.height;

        const params = this.getPrintParams(scale, customScale, orientation, bounds, splitToPages);

        container.style.width = `${params.canvasWidth}px`;
        container.style.height = `${params.canvasHeight}px`;
        map.resize();
        
        const zoom = this.getZoomForScale(params.scaleValue, map.getCenter().lat);

        const pdf = new jsPDF({
            orientation: params.isLandscape ? "landscape" : "portrait",
            unit: "mm",
            format: "a4"
        });
        
        if (!splitToPages) {
            if (scale === "fit") {
                await this.mapService.fitBounds(bounds, 100);
            } else {
                map.setCenter([SpatialService.getCenter([bounds.southWest, bounds.northEast]).lng, SpatialService.getCenter([bounds.southWest, bounds.northEast]).lat]);
                map.setZoom(zoom);
            }
            await this.waitForIdle(map);
            pdf.addImage(map.getCanvas().toDataURL("image/png"), "PNG", params.marginMm, params.marginMm, params.pageMmWidth, params.pageMmHeight);
        } else {
            for (let r = 0; r < params.rows; r++) {
                for (let c = 0; c < params.cols; c++) {
                    const centerLat = bounds.southWest.lat + (params.totalHeightMeters - (r * (params.pageHeightMeters - params.overlapMm * params.scaleValue / 1000)) - (params.pageHeightMeters / 2) + params.shiftY) / 111320;
                    const centerLng = bounds.southWest.lng + (c * (params.pageWidthMeters - params.overlapMm * params.scaleValue / 1000) + (params.pageWidthMeters / 2) - params.shiftX) / (111320 * Math.cos(bounds.southWest.lat * Math.PI / 180));
                    
                    map.setCenter([centerLng, centerLat]);
                    map.setZoom(zoom);
                    await this.waitForIdle(map);
                    
                    if (r > 0 || c > 0) pdf.addPage();
                    const canvas = map.getCanvas();
                    const jpgDataUrl = canvas.toDataURL("image/jpeg", 0.85);
                    pdf.addImage(jpgDataUrl, "JPEG", params.marginMm, params.marginMm, params.pageMmWidth, params.pageMmHeight, undefined, "FAST");
                }
            }
        }

        container.style.width = originalWidth;
        container.style.height = originalHeight;
        map.resize();

        const fileName = `map_${new Date().getTime()}.pdf`;
        if (this.runningContextService.isCapacitor) {
            const savedFile = await Filesystem.writeFile({
                path: fileName,
                data: pdf.output("datauristring").split(",")[1],
                directory: Directory.Cache
            });
            await Share.share({ url: savedFile.uri });
        } else {
            pdf.save(fileName);
        }
    }


    private getZoomForScale(scale: number, latitude: number): number {
        const metersPerPixel = scale * 0.0254 / 300;
        const resolutionAtZoom0 = 40075016.686 * Math.cos(latitude * Math.PI / 180) / 512;
        const zoom = Math.log2(resolutionAtZoom0 / metersPerPixel);
        return zoom;
    }

    private getLatlngs(routeData: RouteData | any): LatLngAltTime[] {
        let latLngs: LatLngAltTime[] = [];
        for (const segment of routeData.segments) {
            latLngs = latLngs.concat(segment.latlngs);
        }
        for (const markers of routeData.markers) {
            latLngs.push(markers.latlng);
        }
        return latLngs;
    }

    private async waitForIdle(map: MapLibreMap): Promise<void> {
        return new Promise<void>(resolve => {
            if (typeof (map as any).isIdle === "function" && (map as any).isIdle()) {
                resolve();
            } else {
                map.once("idle", resolve);
            }
        });
    }

    private async getPdfBase64(imageData: string, isLandscape: boolean): Promise<string> {
        const pdf = new jsPDF({
            orientation: isLandscape ? "landscape" : "portrait",
            unit: "mm",
            format: "a4"
        });
        pdf.addImage(imageData, "PNG", 0, 0, isLandscape ? 297 : 210, isLandscape ? 210 : 297);
        return pdf.output("datauristring").split(",")[1];
    }
}
