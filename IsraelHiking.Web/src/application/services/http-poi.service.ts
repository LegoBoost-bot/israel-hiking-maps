import { HttpClient } from "@angular/common/http";
import { inject, Service } from "@angular/core";
import { firstValueFrom, timeout } from "rxjs";

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
};

@Service()
export class HttpPoiService {
    private readonly TIMEOUT = 3000;
    private readonly httpClient: HttpClient = inject(HttpClient);

    public async getPois(z: number, x: number, y: number): Promise<GeoJSON.FeatureCollection<GeoJSON.Point>> {
        console.log('hi');
        if (z < 10 || z > 16) {
            return { type: "FeatureCollection", features: [] };
        }
        const address = `https://amudanan.co.il/cache/tiles/z_x1_${z}_x2_y_x1_${y}_x2_x_x1_${x}_x2_layers_x1_points.json`;
        const pois = await firstValueFrom(this.httpClient.get<HttpPoiResponse>(address).pipe(timeout(this.TIMEOUT)));
        console.log(pois);
        
        return {
            type: "FeatureCollection",
            features: pois.points.map(poi => ({
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [poi.lon, poi.lat]
                },
                properties: {
                    name: poi.title,
                    description: poi.description,
                    poiSource: "HttpPoi",
                    poiCategory: "HttpPoi",
                    poiId: `HttpPoi_${poi.id}`,
                    identifier: poi.id,
                    poiIcon: "icon-marker",
                    poiIconColor: "black"
                }
            }))
        };
    }
}
