import { Component, inject } from "@angular/core";
import { MatButton } from "@angular/material/button";
import { Dir } from "@angular/cdk/bidi";

import { ResourcesService } from "../services/resources.service";
import { PrintAreaSelectionService } from "../services/print-area-selection.service";

/**
 * The bar that tells the user how to adjust the area to print on the main map, and returns to the
 * print dialog when they are done.
 */
@Component({
    selector: "print-area-selection",
    templateUrl: "./print-area-selection.component.html",
    imports: [MatButton, Dir]
})
export class PrintAreaSelectionComponent {
    public readonly resources = inject(ResourcesService);
    public readonly printAreaSelectionService = inject(PrintAreaSelectionService);
}
