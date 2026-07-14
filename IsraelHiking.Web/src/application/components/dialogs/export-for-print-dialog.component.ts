import { Component, inject } from "@angular/core";
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

export type ExportForPrintDialogData = {
    route?: RouteData;
};

@Component({
    selector: "export-for-print-dialog",
    templateUrl: "export-for-print-dialog.component.html",
    styleUrls: ["export-for-print-dialog.component.scss"],
    imports: [MatDialogModule, MatButton, MatFormFieldModule, MatInput, MatSelect, MatOption, FormsModule, Dir, MatRadioButton, MatRadioGroup, MatCheckbox]
})
export class ExportForPrintDialogComponent {
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
    public paperSize: "A5" | "A4" | "A3" | "Letter" = "A4";
    public splitPages = false;
    public includeHillshade = true;
    public warning: string | null = null;
    public mode: "view" | "all" | "route" = this.data.route ? "route" : "view";

    public async export() {
        await this.printService.export(this.format, this.scale, this.customScale, this.orientation, this.paperSize, this.splitPages, this.mode === "route" ? this.data.route : undefined, this.mode, this.includeHillshade);
        this.dialogRef.close();
    }

    public checkFit() {
        if (this.scale === "fit") {
            this.warning = null;
            return;
        }

        let latlngs: LatLngAltTime[] = [];
        if (this.mode === "route" && this.data.route) {
            latlngs = this.getLatlngs(this.data.route);
        } else if (this.mode === "all") {
            const mapBounds = this.mapService.getMapBounds();
            const allRoutes = this.store.selectSnapshot((s: ApplicationState) => s.routes.present);
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

        if (latlngs.length === 0) {
            this.warning = null;
            return;
        }

        const bounds = SpatialService.getBounds(latlngs);
        
        const widthMeters = SpatialService.getDistanceInMeters(
            { lat: bounds.southWest.lat, lng: bounds.southWest.lng, alt: 0 },
            { lat: bounds.southWest.lat, lng: bounds.northEast.lng, alt: 0 }
        );
        const heightMeters = SpatialService.getDistanceInMeters(
            { lat: bounds.southWest.lat, lng: bounds.southWest.lng, alt: 0 },
            { lat: bounds.northEast.lat, lng: bounds.southWest.lng, alt: 0 }
        );
        
        const scaleValue = this.scale === "custom" ? this.customScale : (this.scale === "1:50000" ? 50000 : 25000);
        
        const widthMm = (widthMeters * 1000) / scaleValue;
        const heightMm = (heightMeters * 1000) / scaleValue;

        const isLandscape = (this.orientation === "landscape") || (this.orientation === "auto" && widthMm > heightMm);
        const sizes = {
            A5: { width: 148, height: 210 },
            A4: { width: 210, height: 297 },
            A3: { width: 297, height: 420 },
            Letter: { width: 215.9, height: 279.4 }
        };
        const pageDimensions = sizes[this.paperSize];
        const pageWidth = isLandscape ? pageDimensions.height : pageDimensions.width;
        const pageHeight = isLandscape ? pageDimensions.width : pageDimensions.height;

        // Apply margins for print (e.g., 10mm)
        if (!this.splitPages && (widthMm > (pageWidth - 20) || heightMm > (pageHeight - 20))) {
            this.warning = "The route does not fit in the selected page size at this scale.";
        } else {
            this.warning = null;
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

