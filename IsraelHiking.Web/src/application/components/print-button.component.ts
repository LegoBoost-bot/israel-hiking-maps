import { Component, inject } from "@angular/core";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatButton } from "@angular/material/button";
import { MatDialog } from "@angular/material/dialog";
import { ExportForPrintDialogComponent } from "./dialogs/export-for-print-dialog.component";
import { ResourcesService } from "../services/resources.service";

@Component({
    selector: "print-button",
    templateUrl: "./print-button.component.html",
    imports: [MatTooltipModule, MatButton]
})
export class PrintButtonComponent {
    public readonly resources = inject(ResourcesService);
    private readonly dialog = inject(MatDialog);

    public openPrintDialog() {
        this.dialog.open(ExportForPrintDialogComponent, {
            data: { route: null }
        });
    }
}
