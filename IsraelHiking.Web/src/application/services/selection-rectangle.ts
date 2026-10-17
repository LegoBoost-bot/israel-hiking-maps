import * as maplibregl from "maplibre-gl";
import type { Map, LngLat, MapMouseEvent, MapTouchEvent, GeoJSONSource } from "maplibre-gl";

import type { Bounds } from "../models";

/**
 * A corner of the rectangle, by the sides of the rectangle it sits on.
 */
type SelectionCorner = {
    isNorth: boolean;
    isEast: boolean;
};

const SELECTION_SOURCE = "print-selection";
const SELECTION_FILL_LAYER = "print-selection-fill";
const SELECTION_LINE_LAYER = "print-selection-line";
const SELECTION_CORNERS: SelectionCorner[] = [
    { isNorth: true, isEast: false },
    { isNorth: true, isEast: true },
    { isNorth: false, isEast: true },
    { isNorth: false, isEast: false }
];
/**
 * The smallest width or height, in degrees, a corner can shrink the rectangle to, so that its corners
 * can not be dragged past one another.
 */
const MIN_SELECTION_SIZE = 0.0005;

/**
 * A rectangle drawn on a map that the user moves by dragging it and resizes by dragging its corners,
 * used to mark the area to print on both the print dialog's preview and the main map.
 */
export class SelectionRectangle {
    private readonly map: Map;
    private readonly onChange: (area: Bounds) => void;
    private readonly cornerMarkers: maplibregl.Marker[];
    private area: Bounds;
    private dragStart: LngLat | null = null;

    /**
     * @param onChange called with the new area when the user lets go of the rectangle after moving or
     * resizing it, and not on every step of the drag.
     */
    constructor(map: Map, area: Bounds, onChange: (area: Bounds) => void) {
        this.map = map;
        this.area = area;
        this.onChange = onChange;
        map.addSource(SELECTION_SOURCE, { type: "geojson", data: this.getPolygon() });
        map.addLayer({
            id: SELECTION_FILL_LAYER,
            type: "fill",
            source: SELECTION_SOURCE,
            paint: {
                "fill-color": "red",
                "fill-opacity": 0.1
            }
        });
        map.addLayer({
            id: SELECTION_LINE_LAYER,
            type: "line",
            source: SELECTION_SOURCE,
            paint: {
                "line-color": "red",
                "line-width": 2
            }
        });
        map.on("mousedown", SELECTION_FILL_LAYER, this.startDrag);
        map.on("touchstart", SELECTION_FILL_LAYER, this.startDrag);
        map.on("mouseenter", SELECTION_FILL_LAYER, this.setMoveCursor);
        map.on("mouseleave", SELECTION_FILL_LAYER, this.clearCursor);
        this.cornerMarkers = SELECTION_CORNERS.map(corner => this.createCornerMarker(corner));
    }

    public getArea(): Bounds {
        return this.area;
    }

    public setArea(area: Bounds) {
        this.area = area;
        this.updateGeometry();
    }

    /**
     * Hides the corner handles, so that the rectangle can be moved but not resized - used when the
     * rectangle is the size of a single printed page.
     */
    public setLocked(locked: boolean) {
        for (const marker of this.cornerMarkers) {
            marker.getElement().classList.toggle("hidden", locked);
        }
    }

    /**
     * Zooms the map out to the rectangle when it does not fit in the part of the map that is shown.
     */
    public ensureVisible(padding: number) {
        const { southWest, northEast } = this.area;
        const mapBounds = this.map.getBounds();
        if (mapBounds.contains([southWest.lng, southWest.lat]) && mapBounds.contains([northEast.lng, northEast.lat])) {
            return;
        }
        this.map.fitBounds([southWest, northEast], { padding });
    }

    public remove() {
        this.map.off("mousedown", SELECTION_FILL_LAYER, this.startDrag);
        this.map.off("touchstart", SELECTION_FILL_LAYER, this.startDrag);
        this.map.off("mouseenter", SELECTION_FILL_LAYER, this.setMoveCursor);
        this.map.off("mouseleave", SELECTION_FILL_LAYER, this.clearCursor);
        this.clearCursor();
        if (this.map.getLayer(SELECTION_FILL_LAYER)) {
            this.map.removeLayer(SELECTION_FILL_LAYER);
            this.map.removeLayer(SELECTION_LINE_LAYER);
            this.map.removeSource(SELECTION_SOURCE);
        }
        for (const marker of this.cornerMarkers) {
            marker.remove();
        }
    }

    /**
     * A handle on a corner of the rectangle that resizes it when dragged, keeping the opposite corner
     * in place.
     */
    private createCornerMarker(corner: SelectionCorner): maplibregl.Marker {
        const element = document.createElement("div");
        const cursor = corner.isNorth === corner.isEast ? "cursor-nesw-resize" : "cursor-nwse-resize";
        element.className = `w-5 h-5 rounded-full bg-white border-2 border-red-600 ${cursor}`;
        const marker = new maplibregl.Marker({ element, draggable: true })
            .setLngLat(this.getCornerLngLat(corner))
            .addTo(this.map);
        marker.on("drag", () => this.resize(corner, marker.getLngLat()));
        marker.on("dragend", () => this.onChange(this.area));
        return marker;
    }

    private resize(corner: SelectionCorner, lngLat: LngLat) {
        const { southWest, northEast } = this.area;
        const north = corner.isNorth ? Math.max(lngLat.lat, southWest.lat + MIN_SELECTION_SIZE) : northEast.lat;
        const south = corner.isNorth ? southWest.lat : Math.min(lngLat.lat, northEast.lat - MIN_SELECTION_SIZE);
        const east = corner.isEast ? Math.max(lngLat.lng, southWest.lng + MIN_SELECTION_SIZE) : northEast.lng;
        const west = corner.isEast ? southWest.lng : Math.min(lngLat.lng, northEast.lng - MIN_SELECTION_SIZE);
        this.setArea({
            northEast: { lat: north, lng: east },
            southWest: { lat: south, lng: west }
        });
    }

    private updateGeometry() {
        this.map.getSource<GeoJSONSource>(SELECTION_SOURCE)?.setData(this.getPolygon());
        SELECTION_CORNERS.forEach((corner, index) => this.cornerMarkers[index].setLngLat(this.getCornerLngLat(corner)));
    }

    private getPolygon(): GeoJSON.Feature<GeoJSON.Polygon> {
        const { southWest, northEast } = this.area;
        return {
            type: "Feature",
            properties: {},
            geometry: {
                type: "Polygon",
                coordinates: [[
                    [southWest.lng, southWest.lat],
                    [northEast.lng, southWest.lat],
                    [northEast.lng, northEast.lat],
                    [southWest.lng, northEast.lat],
                    [southWest.lng, southWest.lat]
                ]]
            }
        };
    }

    private getCornerLngLat(corner: SelectionCorner): [number, number] {
        const { southWest, northEast } = this.area;
        return [corner.isEast ? northEast.lng : southWest.lng, corner.isNorth ? northEast.lat : southWest.lat];
    }

    /**
     * Starts moving the rectangle with the pointer. Preventing the default of the map's event keeps the
     * map from panning along with the rectangle, and a touch with more than one finger is left to the
     * map so that pinching to zoom still works on top of the rectangle.
     */
    private readonly startDrag = (e: MapMouseEvent | MapTouchEvent) => {
        const isTouch = e.type === "touchstart";
        if (isTouch && (e as MapTouchEvent).points.length !== 1) {
            return;
        }
        e.preventDefault();
        this.dragStart = e.lngLat;
        this.map.on(isTouch ? "touchmove" : "mousemove", this.move);
        this.map.once(isTouch ? "touchend" : "mouseup", this.endDrag);
    };

    private readonly move = (e: MapMouseEvent | MapTouchEvent) => {
        if (this.dragStart == null) {
            return;
        }
        const deltaLat = e.lngLat.lat - this.dragStart.lat;
        const deltaLng = e.lngLat.lng - this.dragStart.lng;
        const { southWest, northEast } = this.area;
        this.dragStart = e.lngLat;
        this.setArea({
            northEast: { lat: northEast.lat + deltaLat, lng: northEast.lng + deltaLng },
            southWest: { lat: southWest.lat + deltaLat, lng: southWest.lng + deltaLng }
        });
    };

    private readonly endDrag = () => {
        this.map.off("mousemove", this.move);
        this.map.off("touchmove", this.move);
        this.dragStart = null;
        this.onChange(this.area);
    };

    private readonly setMoveCursor = () => {
        this.map.getCanvas().style.cursor = "move";
    };

    private readonly clearCursor = () => {
        this.map.getCanvas().style.cursor = "";
    };
}
