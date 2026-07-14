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

    public async export(format: "pdf" | "png", scale: string, customScale: number, orientation: "portrait" | "landscape" | "auto", route: RouteData | undefined, mode: "view" | "all" | "route", includeHillshade: boolean, splitToPages: boolean) {
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
        }

        const container = map.getContainer();
        const originalWidth = container.style.width;
        const originalHeight = container.style.height;

        let width = 3508;
        let height = 2480;
        let isLandscape = false;
        if (orientation === "auto") {
            isLandscape = container.offsetWidth > container.offsetHeight;
        } else {
            isLandscape = orientation === "landscape";
        }
        if (!isLandscape) {
            width = 2480;
            height = 3508;
        }

        const latlngs: LatLngAltTime[] = [];
        if (mode === "route" && route) {
            latlngs.push(...this.getLatlngs(route));
        } else if (mode === "all") {
            const mapBounds = this.mapService.getMapBounds();
            for (const r of allRoutes.filter(r => r.state !== "Hidden")) {
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
        
        container.style.width = `${width}px`;
        container.style.height = `${height}px`;
        map.resize();
        
        const scaleValue = scale === "fit" ? 25000 : (scale === "custom" ? customScale : (scale === "1:50000" ? 50000 : 25000));
        const zoom = this.getZoomForScale(scaleValue, map.getCenter().lat);

        const pdf = new jsPDF({
            orientation: isLandscape ? "landscape" : "portrait",
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
            pdf.addImage(map.getCanvas().toDataURL("image/png"), "PNG", 0, 0, isLandscape ? 297 : 210, isLandscape ? 210 : 297);
        } else {
            const pageMmWidth = isLandscape ? 297 : 210;
            const pageMmHeight = isLandscape ? 210 : 297;
            const overlapMm = 15;
            
            const pageWidthMeters = (pageMmWidth * scaleValue) / 1000;
            const pageHeightMeters = (pageMmHeight * scaleValue) / 1000;
            
            const totalWidthMeters = SpatialService.getDistanceInMeters({ lat: bounds.southWest.lat, lng: bounds.southWest.lng, alt: 0 }, { lat: bounds.southWest.lat, lng: bounds.northEast.lng, alt: 0 });
            const totalHeightMeters = SpatialService.getDistanceInMeters({ lat: bounds.southWest.lat, lng: bounds.southWest.lng, alt: 0 }, { lat: bounds.northEast.lat, lng: bounds.southWest.lng, alt: 0 });
            
            const cols = Math.ceil((totalWidthMeters - overlapMm * scaleValue / 1000) / (pageWidthMeters - overlapMm * scaleValue / 1000));
            const rows = Math.ceil((totalHeightMeters - overlapMm * scaleValue / 1000) / (pageHeightMeters - overlapMm * scaleValue / 1000));
            
            const shiftX = (((cols * (pageWidthMeters - overlapMm * scaleValue / 1000) + overlapMm * scaleValue / 1000) - totalWidthMeters) / 2);
            const shiftY = (((rows * (pageHeightMeters - overlapMm * scaleValue / 1000) + overlapMm * scaleValue / 1000) - totalHeightMeters) / 2);

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const centerLat = bounds.southWest.lat + (totalHeightMeters - (r * (pageHeightMeters - overlapMm * scaleValue / 1000)) - (pageHeightMeters / 2) + shiftY) / 111320;
                    const centerLng = bounds.southWest.lng + (c * (pageWidthMeters - overlapMm * scaleValue / 1000) + (pageWidthMeters / 2) - shiftX) / (111320 * Math.cos(bounds.southWest.lat * Math.PI / 180));
                    
                    map.setCenter([centerLng, centerLat]);
                    map.setZoom(zoom);
                    await this.waitForIdle(map);
                    
                    if (r > 0 || c > 0) pdf.addPage();
                    const canvas = map.getCanvas();
                    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
                    pdf.addImage(dataUrl, "JPEG", 0, 0, isLandscape ? 297 : 210, isLandscape ? 210 : 297, undefined, "FAST");
                }
            }
        }

        container.style.width = originalWidth;
        container.style.height = originalHeight;
        map.resize();

        if (route) {
            for (const [id, state] of originalRouteStates) {
                this.store.dispatch(new ChangeRouteStateAction(id, state as any));
            }
        }

        for (const hillshadeLayer of hillshadeLayerIds) {
            map.setLayoutProperty(hillshadeLayer.id, "visibility", hillshadeLayer.visibility as any);
        }

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
