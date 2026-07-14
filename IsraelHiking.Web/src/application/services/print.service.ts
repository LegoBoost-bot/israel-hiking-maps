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

    public async export(format: "pdf" | "png", scale: string, customScale: number, orientation: "portrait" | "landscape" | "auto", paperSize: "A5" | "A4" | "A3" | "Letter", splitPages: boolean, route: RouteData | undefined, mode: "view" | "all" | "route", includeHillshade: boolean) {
        const map = this.mapService.map;
        if (!map) {
            return;
        }

        const sizes = {
            A5: { width: 148, height: 210 },
            A4: { width: 210, height: 297 },
            A3: { width: 297, height: 420 },
            Letter: { width: 215.9, height: 279.4 }
        };
        const paperDimensionsMm = sizes[paperSize];

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

        let bounds: any;

        if (mode === "route" && route) {
            const latlngs = this.getLatlngs(route);
            bounds = SpatialService.getBounds(latlngs);
        } else if (mode === "all") {
            const mapBounds = this.mapService.getMapBounds();
            const latlngs: LatLngAltTime[] = [];
            const visibleRouteNamesInViewport: string[] = [];
            for (const r of allRoutes.filter(r => r.state !== "Hidden")) {
                const routeLatlngs = this.getLatlngs(r);
                const isAnyPointInViewport = routeLatlngs.some(pt => {
                    return pt.lng >= mapBounds.southWest.lng && pt.lng <= mapBounds.northEast.lng &&
                        pt.lat >= mapBounds.southWest.lat && pt.lat <= mapBounds.northEast.lat;
                });
                if (isAnyPointInViewport) {
                    visibleRouteNamesInViewport.push(r.name);
                    latlngs.push(...routeLatlngs);
                }
            }
            console.log("Visible route names in viewport for print:", visibleRouteNamesInViewport);
            if (latlngs.length > 0) {
                bounds = SpatialService.getBounds(latlngs);
            }
        }

        const scaleValue = scale === "custom" ? customScale : (scale === "1:50000" ? 50000 : 25000);
        let isLandscape = false;
        if (orientation === "auto" && bounds) {
             isLandscape = (bounds.northEast.lng - bounds.southWest.lng) > (bounds.northEast.lat - bounds.southWest.lat);
        } else {
            isLandscape = orientation === "landscape";
        }

        const pageWidth = isLandscape ? paperDimensionsMm.height : paperDimensionsMm.width;
        const pageHeight = isLandscape ? paperDimensionsMm.width : paperDimensionsMm.height;

        let grids: any[] = [];
        if (splitPages && bounds) {
            grids = SpatialService.calculateGridBounds(bounds, scaleValue, { width: pageWidth, height: pageHeight });
        } else if (bounds) {
            grids = [bounds];
        } else {
            grids = [this.mapService.getMapBounds()];
        }

        container.style.width = `${Math.floor(pageWidth * 300 / 25.4)}px`;
        container.style.height = `${Math.floor(pageHeight * 300 / 25.4)}px`;
        map.resize();

        const dataUrls: string[] = [];
        
        for (const gridBounds of grids) {
            if (scale === "fit") {
                await this.mapService.fitBounds(gridBounds, 50);
            } else {
                const zoom = this.getZoomForScale(scaleValue, (gridBounds.southWest.lat + gridBounds.northEast.lat) / 2);
                const center = SpatialService.getCenter([gridBounds.southWest, gridBounds.northEast]);
                map.setCenter([center.lng, center.lat]);
                map.setZoom(zoom);
            }

            await new Promise<void>(resolve => {
                if (typeof (map as any).isIdle === "function" && (map as any).isIdle()) {
                    resolve();
                } else {
                    map.once("idle", resolve);
                }
            });

            dataUrls.push(map.getCanvas().toDataURL("image/png"));
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

        const fileName = `map_${new Date().getTime()}.${format}`;

        if (this.runningContextService.isCapacitor) {
            const savedFile = await Filesystem.writeFile({
                path: fileName,
                data: format === "pdf" ? await this.getPdfBase64(dataUrls, isLandscape, paperSize) : dataUrls[0].split(",")[1],
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
                    format: paperSize
                });
                for (let i = 0; i < dataUrls.length; i++) {
                    if (i > 0) {
                        pdf.addPage();
                    }
                    pdf.addImage(dataUrls[i], "PNG", 0, 0, isLandscape ? paperDimensionsMm.height : paperDimensionsMm.width, isLandscape ? paperDimensionsMm.width : paperDimensionsMm.height);
                }
                pdf.save(fileName);
            } else {
                const link = document.createElement("a");
                link.href = dataUrls[0];
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

    private async getPdfBase64(imageDatas: string[], isLandscape: boolean, paperSize: string): Promise<string> {
        const pdf = new jsPDF({
            orientation: isLandscape ? "landscape" : "portrait",
            unit: "mm",
            format: paperSize as any
        });
        const sizes = {
            A5: { width: 148, height: 210 },
            A4: { width: 210, height: 297 },
            A3: { width: 297, height: 420 },
            Letter: { width: 215.9, height: 279.4 }
        };
        const paperDimensionsMm = sizes[paperSize as keyof typeof sizes];
        const pageWidth = isLandscape ? paperDimensionsMm.height : paperDimensionsMm.width;
        const pageHeight = isLandscape ? paperDimensionsMm.width : paperDimensionsMm.height;
        
        for (let i = 0; i < imageDatas.length; i++) {
            if (i > 0) {
                pdf.addPage();
            }
            pdf.addImage(imageDatas[i], "PNG", 0, 0, pageWidth, pageHeight);
        }
        return pdf.output("datauristring").split(",")[1];
    }
}
