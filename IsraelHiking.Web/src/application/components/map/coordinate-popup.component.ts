import { Component, inject, input } from "@angular/core";
import { MatMenu, MatMenuItem, MatMenuTrigger } from "@angular/material/menu";
import { MatButton } from "@angular/material/button";
import { CdkCopyToClipboard } from "@angular/cdk/clipboard";
import { Share } from "@capacitor/share";
import { ToastService } from "../../services/toast.service";
import { NavigateHereService } from "../../services/navigate-here.service";
import { ResourcesService } from "../../services/resources.service";
import { MatTooltip } from "@angular/material/tooltip";

@Component({
    selector: "coordinate-popup",
    templateUrl: "./coordinate-popup.component.html",
    imports: [MatMenu, MatMenuItem, MatMenuTrigger, MatButton, MatTooltip, CdkCopyToClipboard]
})
export class CoordinatePopupComponent {
    public readonly lat = input.required<number>();
    public readonly lng = input.required<number>();
    public readonly itm = input.required<{ north: number; east: number }>();
    public readonly elevation = input<number | null>(null);

    public readonly toastService = inject(ToastService);
    private readonly navigateHereService = inject(NavigateHereService);
    public readonly resources = inject(ResourcesService);

    public navigateHere() {
        this.navigateHereService.addNavigationSegment({ lat: this.lat(), lng: this.lng() }, "Target Location");
    }

    public async share() {
        await Share.share({
            text: `${this.lat()},${this.lng()}`
        });
    }

    public getWazeUrl() {
        return `https://waze.com/ul?ll=${this.lat()},${this.lng()}&navigate=yes`;
    }

    public getGoogleMapsUrl() {
        return `https://www.google.com/maps/dir/?api=1&destination=${this.lat()},${this.lng()}`;
    }

    public getLatLonString() {
        return `${this.lat().toFixed(5)}, ${this.lng().toFixed(5)}`;
    }

    public getItmString(withNewline = false) {
        const format = (n: number) => {
            const s = Math.round(n).toString();
            return s.length > 3 ? `${s.slice(0, -3)} ${s.slice(-3)}` : s;
        };
        return withNewline
            ? `${format(this.itm().north)}\n${format(this.itm().east)}`
            : `${Math.round(this.itm().north)} / ${Math.round(this.itm().east)}`;
    }
}
