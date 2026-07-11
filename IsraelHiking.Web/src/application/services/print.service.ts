import { inject, Injectable } from "@angular/core";
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

    public async export(format: "pdf" | "png", scale: string, customScale: number, orientation: "portrait" | "landscape" | "auto", route: RouteData | undefined, mode: "view" | "all" | "route", includeHillshade: boolean) {
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
                if (layer.type === 'hillshade') {
                    hillshadeLayerIds.push({ id: layer.id, visibility: map.getLayoutProperty(layer.id, 'visibility') });
                    map.setLayoutProperty(layer.id, 'visibility', 'none');
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

        let width = 2480;
        let height = 3508;
        let isLandscape = false;
        
        let bounds: any;

        if (mode === "route" && route) {
            const latlngs = this.getLatlngs(route);
            bounds = SpatialService.getBounds(latlngs);
        } else if (mode === "all") {
            const latlngs: LatLngAltTime[] = [];
            for (const r of allRoutes.filter(r => r.state !== "Hidden")) {
                latlngs.push(...this.getLatlngs(r));
            }
            if (latlngs.length > 0) {
                bounds = SpatialService.getBounds(latlngs);
            }
        }

        if (bounds) {
            if (format === "png") {
                const ne = map.project([bounds.northEast.lng, bounds.northEast.lat]);
                const sw = map.project([bounds.southWest.lng, bounds.southWest.lat]);
                width = Math.abs(ne.x - sw.x) + 200;
                height = Math.abs(ne.y - sw.y) + 200;
            } else {
                if (orientation === "auto") {
                    isLandscape = (bounds.northEast.lng - bounds.southWest.lng) > (bounds.northEast.lat - bounds.southWest.lat);
                } else {
                    isLandscape = orientation === "landscape";
                }
                if (isLandscape) {
                    width = 3508;
                    height = 2480;
                }
            }
        } else if (format === "pdf") {
            if (orientation === "auto") {
                isLandscape = container.offsetWidth > container.offsetHeight;
            } else {
                isLandscape = orientation === "landscape";
            }
            if (isLandscape) {
                width = 3508;
                height = 2480;
            }
        }

        container.style.width = `${width}px`;
        container.style.height = `${height}px`;
        map.resize();

        if (bounds && scale === "fit") {
            await this.mapService.fitBounds(bounds, 100);
        } else if (scale !== "fit") {
            const scaleValue = scale === "custom" ? customScale : (scale === "1:50000" ? 50000 : 25000);
            const zoom = this.getZoomForScale(scaleValue, map.getCenter().lat);
            if (bounds) {
                const center = SpatialService.getCenter([bounds.southWest, bounds.northEast]);
                map.setCenter([center.lng, center.lat]);
            }
            map.setZoom(zoom);
        }

        await new Promise<void>(resolve => {
            if (typeof (map as any).isIdle === "function" && (map as any).isIdle()) {
                resolve();
            } else {
                map.once("idle", resolve);
            }
        });

        const canvas = map.getCanvas();
        const dataUrl = canvas.toDataURL("image/png");

        container.style.width = originalWidth;
        container.style.height = originalHeight;
        map.resize();

        if (route) {
            for (const [id, state] of originalRouteStates) {
                this.store.dispatch(new ChangeRouteStateAction(id, state as any));
            }
        }

        for (const hillshadeLayer of hillshadeLayerIds) {
            map.setLayoutProperty(hillshadeLayer.id, 'visibility', hillshadeLayer.visibility as any);
        }

        const fileName = `map_${new Date().getTime()}.${format}`;
        const base64Data = dataUrl.split(",")[1];

        if (this.runningContextService.isCapacitor) {
            const savedFile = await Filesystem.writeFile({
                path: fileName,
                data: format === "pdf" ? await this.getPdfBase64(dataUrl, isLandscape) : base64Data,
                directory: Directory.Cache
            });
            await Share.share({
                url: savedFile.uri
            });
        } else {
            if (format === "pdf") {
                const pdf = new jsPDF({
                    orientation: isLandscape ? "landscape" : "portrait",
                    unit: "mm",
                    format: "a4"
                });
                pdf.addImage(dataUrl, "PNG", 0, 0, isLandscape ? 297 : 210, isLandscape ? 210 : 297);
                pdf.save(fileName);
            } else {
                const link = document.createElement("a");
                link.href = dataUrl;
                link.download = fileName;
                link.click();
            }
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
