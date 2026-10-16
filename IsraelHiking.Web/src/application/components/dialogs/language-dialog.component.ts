import { Component, inject, signal } from "@angular/core";
import { Dir } from "@angular/cdk/bidi";
import { MatButton , MatIconButton } from "@angular/material/button";
import { CdkScrollable } from "@angular/cdk/scrolling";
import { MatRadioGroup, MatRadioButton } from "@angular/material/radio";
import { MatFormField, MatLabel } from "@angular/material/form-field";
import { MatSelect, MatOption } from "@angular/material/select";
import { FormsModule } from "@angular/forms";
import { AnimationOptions, LottieComponent } from "ngx-lottie";
import { MatTooltip } from "@angular/material/tooltip";
import { MatDialog, MatDialogTitle, MatDialogClose, MatDialogContent, MatDialogActions } from "@angular/material/dialog";
import { Store } from "@ngxs/store";

import { AnalyticsDirective } from "../../directives/analytics.directive";
import { ResourcesService } from "../../services/resources.service";
import { AVAILABLE_LANGUAGES } from "../../reducers/initial-state";
import { SetMapLanguageAction } from "../../reducers/configuration.reducer";
import { ApplicationState, LanguageCode } from "../../models";

/**
 * The option that stands for not picking a map language, since a mat-select treats a null option as no selection.
 */
const SAME_AS_APP_LANGUAGE = "same-as-app";

@Component({
    selector: "language-dialog",
    templateUrl: "./language-dialog.component.html",
    imports: [MatIconButton, Dir, MatDialogTitle, MatButton, MatDialogClose, CdkScrollable, MatDialogContent, MatRadioGroup, FormsModule, MatRadioButton, AnalyticsDirective, MatDialogActions, MatTooltip, LottieComponent, MatFormField, MatLabel, MatSelect, MatOption]
})
export class LanguageDialogComponent {
    public readonly sameAsAppLanguage = SAME_AS_APP_LANGUAGE;
    public readonly selectedLanguageCode = signal<LanguageCode>(null);
    public readonly selectedMapLanguageCode = signal<LanguageCode | typeof SAME_AS_APP_LANGUAGE>(null);
    public readonly availableLanguages = AVAILABLE_LANGUAGES;
    readonly lottieLanguage: AnimationOptions = { path: "content/lottie/dialog-language.json" };

    public readonly resources = inject(ResourcesService);

    private readonly store = inject(Store);

    constructor() {
        const configuration = this.store.selectSnapshot((s: ApplicationState) => s.configuration);
        this.selectedLanguageCode.set(configuration.language.code);
        this.selectedMapLanguageCode.set(configuration.mapLanguage ?? this.sameAsAppLanguage);
    }

    public static openDialog(dialog: MatDialog) {
        dialog.open(LanguageDialogComponent, {
            minWidth: "300px"
        });
    }

    public saveLanguage() {
        const mapLanguageCode = this.selectedMapLanguageCode();
        this.store.dispatch(new SetMapLanguageAction(mapLanguageCode === this.sameAsAppLanguage ? null : mapLanguageCode));
        this.resources.setLanguage(this.selectedLanguageCode());
    }
}
