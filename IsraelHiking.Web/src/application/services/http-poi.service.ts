import { HttpClient } from "@angular/common/http";
import { inject, Service } from "@angular/core";
import { firstValueFrom, timeout } from "rxjs";
import { PoiProperties } from "./osm-tags.service";
import { GeoJSONUtils } from "./geojson-utils";
import { SpatialService } from "./spatial.service";

type HttpPoiResponse = {
    points: HttpPoi[];
};

type HttpPoi = {
    id: string;
    title: string;
    description: string;
    lon: number;
    lat: number;
    lastupdate: string;
    images?: string;
    pointtype: string;
};

@Service()
export class HttpPoiService {
    private readonly TIMEOUT = 3000;
    private readonly httpClient: HttpClient = inject(HttpClient);

    private readonly MINZOOM = 12;
    private readonly MAXZOOM = 14;

    private readonly MAX_CACHE_SIZE = 1024;
    private readonly poiStore = new Map<string, GeoJSON.Feature<GeoJSON.Point>>();

    private ensureCapacity() {
        if (this.poiStore.size >= this.MAX_CACHE_SIZE) {
            this.poiStore.delete(this.poiStore.keys().next().value!);
        }
    }

    public getFeatureById(id: string): GeoJSON.Feature<GeoJSON.Point> | undefined {
        return this.poiStore.get(id);
    }

    public async getPois(z: number, x: number, y: number): Promise<GeoJSON.FeatureCollection<GeoJSON.Point>> {
        if (z < this.MINZOOM) {
            return { type: "FeatureCollection", features: [] };
        }
        if (z > this.MAXZOOM) {
            x = Math.floor(x * Math.pow(2, this.MAXZOOM - z));
            y = Math.floor(y * Math.pow(2, this.MAXZOOM - z));
            z = this.MAXZOOM;
        }
        const address = `https://amudanan.co.il/cache/tiles/z_x1_${z}_x2_y_x1_${y}_x2_x_x1_${x}_x2_layers_x1_points.json`;
        const pois = await firstValueFrom(this.httpClient.get<HttpPoiResponse>(address).pipe(timeout(this.TIMEOUT)));

        const dedupedPois: GeoJSON.Feature<GeoJSON.Point>[] = [];
        const seen = new Set();

        for (const poi of pois.points) {
            if (seen.has(`${poi.title}-${poi.lon}-${poi.lat}`)) {
                continue;
            }

            const feature: GeoJSON.Feature<GeoJSON.Point> = {
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [poi.lon, poi.lat],
                },
                properties: {
                    name: poi.title,
                    description: poi.description,
                    poiSource: "AmudAnan",
                    poiId: `AmudAnan_${poi.id}`,
                    identifier: poi.id,
                }
            };

            if (poi.images) {
                this.addImages(feature, poi.images);
            }

            GeoJSONUtils.setLocation(feature, SpatialService.toLatLng([poi.lon, poi.lat]));

            this.addWebsite(feature);

            this.setIconColorCategory(feature, poi.pointtype);
            
            this.ensureCapacity();
            this.poiStore.set(poi.id, feature);
            dedupedPois.push(feature);
            seen.add(`${poi.title}-${poi.lon}-${poi.lat}`);
        }
        
        return {
            type: "FeatureCollection",
            features: dedupedPois,
        };
    }

    private setIconColorCategory(feature: GeoJSON.Feature<GeoJSON.Point>, pointtype: string) {
        const WATER_BLUE = "#1e80e3";

        switch (pointtype) {
            case "מעין":
            case "מים":
            case "מעין נקבה":
            case "בריכה":
            case "מים - אחר":
                feature.properties.poiIconColor = WATER_BLUE;
                feature.properties.poiIcon = "icon-tint";
                feature.properties.poiCategory = "Water";
                break;
            case "מפל":
                feature.properties.poiIconColor = WATER_BLUE;
                feature.properties.poiIcon = "icon-waterfall";
                feature.properties.poiCategory = "Water";
                break;
            case "נחל":
                feature.properties.poiIconColor = WATER_BLUE;
                feature.properties.poiIcon = "icon-river";
                feature.properties.poiCategory = "Water";
                break;
            case "תצפית":
                feature.properties.poiIconColor = "#008000";
                feature.properties.poiIcon = "icon-viewpoint";
                feature.properties.poiCategory = "Viewpoint";
                break;
            case "עץ, עצים":
            case "עץ. עצים":
                feature.properties.poiIconColor = "#008000";
                feature.properties.poiIcon = "icon-tree";
                feature.properties.poiCategory = "Natural";
                break;
            case "בית כנסת":
                feature.properties.poiIconColor = "black";
                feature.properties.poiIcon = "icon-synagogue";
                feature.properties.poiCategory = "Other";
                break;
            case "פריחה":
                feature.properties.poiIconColor = "#008000";
                feature.properties.poiIcon = "icon-flowers";
                feature.properties.poiCategory = "Natural";
                break;
            case "מחצבה":
                feature.properties.poiIconColor = "gray";
                feature.properties.poiIcon = "icon-quarry";
                feature.properties.poiCategory = "Other";
                break;
            case "מערה":
                feature.properties.poiIconColor = "black";
                feature.properties.poiIcon = "icon-cave";
                feature.properties.poiCategory = "Other";
                break;
            case "אתר היסטורי":
            case "אתר ארכיאולוגי":
            case "ארכיאולוגיה":
                feature.properties.poiIconColor = "#666666";
                feature.properties.poiIcon = "icon-archaeological";
                feature.properties.poiCategory = "Historic";
                break;
            case "אנדרטה":
            case "קבר":
                feature.properties.poiIconColor = "#666666";
                feature.properties.poiIcon = "icon-memorial";
                feature.properties.poiCategory = "Historic";
                break;
            case "ישוב":
                feature.properties.poiIconColor = "black";
                feature.properties.poiIcon = "icon-home";
                feature.properties.poiCategory = "Other";
                break;
            case "חורבה":
                feature.properties.poiIconColor = "#666666";
                feature.properties.poiIcon = "icon-ruins";
                feature.properties.poiCategory = "Historic";
                break;
            default:
                feature.properties.poiIconColor = "black";
                feature.properties.poiIcon = "icon-globe";
                feature.properties.poiCategory = "Other";
        }
    }

    private addImages(feature: GeoJSON.Feature<GeoJSON.Point>, images: string) {
        images.split(',').forEach((image: string, index: number) => {
            var correctedImage = image.replace(' ', '_');
            const url = `https://amudanan.co.il/w/images/${correctedImage}`;
            feature.properties[`image${index}`] = url;
        });
    }

    private addWebsite(feature: GeoJSON.Feature<GeoJSON.Point>) {
        feature.properties.website = `https://amudanan.co.il/w/P${feature.properties.identifier}`;
    }
}
