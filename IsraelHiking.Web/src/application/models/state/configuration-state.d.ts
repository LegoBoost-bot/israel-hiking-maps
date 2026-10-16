import { Language, LanguageCode } from "../language";

export type BatteryOptimizationType = "screen-on" | "dark" | "screen-off";

export type Theme = "light" | "dark";

/**
 * The theme the user picked - "auto" is resolved to a {@link Theme} according to sunrise and sunset
 * at the current GPS position, see ThemeService.
 */
export type ThemeSetting = Theme | "auto";

export type ConfigurationState = {
    batteryOptimizationType: BatteryOptimizationType;
    theme: ThemeSetting;
    isAutomaticRecordingUpload: boolean;
    isGotLostWarnings: boolean;
    isShowBatteryConfirmation: boolean;
    isShowSlope: boolean;
    isShowKmMarker: boolean;
    isShowOnboarding: boolean;
    version: number;
    language: Language;
    /**
     * The language of the labels and sites drawn on the map, or null to follow {@link language}.
     */
    mapLanguage: LanguageCode | null;
    units: "metric" | "imperial";
    dateFormat: string;
};
