import { LightningElement, api, wire } from 'lwc';
import { loadStyle, loadScript } from 'lightning/platformResourceLoader';
import { refreshApex } from '@salesforce/apex';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import LEAFLET from '@salesforce/resourceUrl/leaflet';
import getLocationMapDetails from '@salesforce/apex/abcHeatMapController.getLocationMapDetails';
import placeAsset from '@salesforce/apex/abcHeatMapController.placeAsset';
import removeAssetPlacement from '@salesforce/apex/abcHeatMapController.removeAssetPlacement';
import uploadHeatMapImage from '@salesforce/apex/abcHeatMapController.uploadHeatMapImage';
import savePolygonCoordinates from '@salesforce/apex/abcHeatMapController.savePolygonCoordinates';
import getImageBase64 from '@salesforce/apex/abcHeatMapController.getImageBase64';
import uploadCanvasImage from '@salesforce/apex/abcHeatMapController.uploadCanvasImage';
import hasHeatMapEditPermission from '@salesforce/customPermission/ABC_HeatMap_Editor_Access';

export default class AbcHeatMap extends LightningElement {
    @api recordId;
    isHeatMapReadOnly = true;
    showSpinner = false;
    map;
    leafletInitialized = false;
    mapData;
    wiredMapResult;
    L;
    placedLayers = [];
    unplacedAssets = [];
    placedTraps = [];

    isDrawingMode = false;
    currentDrawingAsset = null;
    currentDrawingAssetName = '';
    drawingPoints = [];
    tempPolygonLayer = null;
    firstPointMarker = null;

    connectedCallback() {
        this.isHeatMapReadOnly = !hasHeatMapEditPermission;
    }

    @wire(getLocationMapDetails, { recordId: '$recordId' })
    wiredMap({ error, data }) {
        this.wiredMapResult = { error, data };
        if (data) {
            this.mapData = data;
            this.unplacedAssets = data.unplacedAssets ? [...data.unplacedAssets] : [];
            this.placedTraps = data.placedAssets ? data.placedAssets.map(td => ({ ...td })) : [];
            if (this.leafletInitialized) {
                setTimeout(() => this.initializeMap(), 150);
            }
        } else if (error) {
            console.error("wiredMap error", error);
        }
    }

    renderedCallback() {
        if (this.leafletInitialized) return;

        Promise.all([
            loadScript(this, LEAFLET + '/dist/leaflet.js'),
            loadStyle(this, LEAFLET + '/dist/leaflet.css')
        ]).then(() => {
            this.L = window.L;
            this.leafletInitialized = true;
            if (this.mapData) this.initializeMap();
        }).catch(err => console.error('Rendered CB Load error', err));
    }

    get paletteClass() {
        return this.isHeatMapReadOnly ? 'trap-palette readonly-palette' : 'trap-palette';
    }

    get hasValidImage() {
        return this.mapData && !!this.mapData.imageUrl;
    }

    get hasValidImage() {
        return this.mapData && !!this.mapData.imageUrl;
    }

    calculateMarkerColorAndOpacity(deviceType, hasFinding) {
        const heatLevel = hasFinding ? 2 : 0; 
        
        const colorMap = {
            'ILT': [60, 100, 90],
            'RBS': [0, 100, 50],
            'IRT/ET': [240, 100, 50],
            'Device Area': [350, 100, 88],
            'MLS': [39, 100, 50],
            'Logbook': [300, 100, 25],
            'TBS': [120, 100, 25],
            'WT': [210, 60, 20],  
            'Zone': [330, 80, 60], 
            'Area': [330, 80, 60],
            'Lawn Zone': [120, 75, 40],
            'Lawn Area': [120, 75, 40],
            'FBS': [0, 0, 50],     
            'PHT': [30, 50, 30],          
            'MISC': [0, 0, 50] 
        };

        let [h, s, l] = colorMap[deviceType] || [0, 0, 80];
        const isAreaType = ['Area', 'Zone', 'Lawn Zone', 'Lawn Area'].includes(deviceType);
        if (isAreaType) l = Math.max(l - 10, 20);

        const isGreyScaleDevice = (deviceType === 'FBS' || deviceType === 'MISC');

        if (!isGreyScaleDevice) {
            if (heatLevel === 0) {
                s *= 0.6;
                l = Math.min(l + 10, 95);
            } else if (heatLevel === 2) {
                s = 100;
                l = Math.max(l - 15, 20);
            }
        } else if (hasFinding) {
            l = 30; 
        }

        return {
            color: `hsl(${h}, ${s}%, ${l}%)`,
            opacity: heatLevel === 0 ? 0.5 : 1.0
        };
    }

    getMarkerShapeSvg(deviceType, color, opacity) {
        const strokeParams = `fill="${color}" fill-opacity="${opacity}" stroke="#000" stroke-width="1"`;
        
        switch (deviceType) {
            case 'ILT': return `<polygon points="12,2 22,22 2,22" ${strokeParams}/>`;
            case 'RBS': return `<rect x="2" y="5" width="20" height="14" ${strokeParams}/>`;
            case 'IRT/ET':
            case 'WT': return `<rect x="3" y="3" width="18" height="18" ${strokeParams}/>`;
            case 'FBS': return `<ellipse cx="12" cy="12" rx="10" ry="6" ${strokeParams}/>`;
            case 'PHT': return `<polygon points="12,2 22,12 12,22 2,12" ${strokeParams}/>`;
            case 'MISC': return `<path d="M4,4 L20,20 M20,4 L4,20" stroke="${color}" stroke-width="4" fill="none" stroke-opacity="${opacity}" stroke-linecap="round"/>`;
            case 'Device Area': return `<path d="M2,12 L18,12 M14,6 L22,12 L14,18" stroke="${color}" stroke-width="3" fill="none" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
            case 'MLS':
            case 'Zone':
            case 'Area':
            case 'Lawn Zone':
            case 'Lawn Area': return `<circle cx="12" cy="12" r="10" ${strokeParams}/>`;
            case 'Logbook': return `<polygon points="12,2 15,9 22,9 17,14 19,21 12,17 5,21 7,14 2,9 9,9" ${strokeParams}/>`;
            case 'TBS': return `<polygon points="8,2 16,2 22,8 22,16 16,22 8,22 2,16 2,8" ${strokeParams}/>`;
            default: return `<circle cx="12" cy="12" r="8" fill="#ccc" />`;
        }
    }

    getDynamicIcon(deviceType, hasFinding) {
        const { color, opacity } = this.calculateMarkerColorAndOpacity(deviceType, hasFinding);
        const shapeSvg = this.getMarkerShapeSvg(deviceType, color, opacity);

        return this.L.divIcon({
            className: 'custom-svg-icon',
            html: `<svg width="24" height="24" viewBox="0 0 24 24">${shapeSvg}</svg>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });
    }

    createMarker(trap) {
        const marker = this.L.marker([trap.y, trap.x], {
            icon: this.getDynamicIcon(trap.deviceType, trap.hasFinding),
            draggable: !this.isHeatMapReadOnly
        }).addTo(this.map);

        marker.assetId = trap.id;
        marker.bindTooltip(trap.name, {
            permanent: true, direction: 'top', offset: [0, -12], className: 'asset-marker-label'
        });

        const popupDiv = this.preparePopup(trap);
        marker.bindPopup(popupDiv);
        marker.on('popupopen', () => {
            const btn = popupDiv.querySelector('.remove-trap-btn');
            if (btn) btn.onclick = () => this.removeTrap(marker.assetId);
        });
        marker.on('dragend', (e) => this.handleMarkerDragEnd(e));

        return marker;
    }

    createPolygonForPlaced(trap) {
        if (!trap.polygonCoordinates || trap.polygonCoordinates.trim() === '') return null;
        try {
            const parsed = JSON.parse(trap.polygonCoordinates);
            const latlngs = parsed.map(coord => this.L.latLng(coord[0], coord[1])).filter(Boolean);

            if (latlngs.length < 3) return null;

            const { color } = this.calculateMarkerColorAndOpacity(trap.deviceType, trap.hasFinding);

            const poly = this.L.polygon(latlngs, {
                color: color,
                weight: 3,
                fillColor: color,
                fillOpacity: 0.45
            }).addTo(this.map);

            poly.assetId = trap.id;
            poly.bindTooltip(trap.name, { direction: 'center', className: 'asset-marker-label' });

            const popupDiv = this.preparePopup(trap);
            poly.bindPopup(popupDiv);
            poly.on('popupopen', () => {
                const btn = popupDiv.querySelector('.remove-trap-btn');
                if (btn) btn.onclick = () => this.removeTrap(poly.assetId);
            });

            return poly;
        } catch (err) {
            console.error('Failed to parse polygon', trap.id, err);
            return null;
        }
    }

    preparePopup(trap) {
        const conditionsHtml = (trap.conduciveConditions?.length > 0) 
            ? `<div style="text-align:left; margin-top:10px; border-top:1px solid #ccc; padding-top:8px;">
                <span style="font-weight:bold; font-size:11px;">Conducive Conditions:</span>
                <ol style="padding-left:15px; margin:5px 0; font-size:11px;">
                    ${trap.conduciveConditions.map(cc => `
                        <li style="margin-bottom:4px;">
                            <a href="/lightning/r/Conducive_Condition__c/${cc.Id}/view" target="_blank" style="color:#0070d2; font-weight:bold;">${cc.Name}</a>: ${cc.Description__c || 'No description'}
                        </li>`).join('')}
                </ol></div>`
            : `<div style="color:#777; font-style:italic; margin-top:5px; font-size:11px;">No conducive conditions found.</div>`;

        const div = this.L.DomUtil.create('div', 'custom-popup');
        div.innerHTML = `
            <div style="min-width:200px; text-align:center;">
                <strong style="font-size:14px;">${trap.name}</strong><br/>
                <span style="color:#555;">Type: ${trap.deviceType} | Finding: ${trap.hasFinding ? 'Yes' : 'No'}</span>
                ${conditionsHtml}
                <div style="margin-top:12px;">
                    <button class="remove-trap-btn" data-asset-id="${trap.id}" style="background:#ef4444; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer; width:100%;">Remove from Map</button>
                </div>
            </div>`;
        return div;
    }

    initializeMap() {
        const el = this.template.querySelector('.map-container');
        if (!this.L || !el || !this.mapData?.imageUrl) return;
        if (this.map) this.map.remove();

        this.map = this.L.map(el, { crs: this.L.CRS.Simple, minZoom: -2, maxZoom: 2, preferCanvas: true });
        const bounds = [[0, 0], [1000, 1000]];
        this.L.imageOverlay(this.mapData.imageUrl, bounds).addTo(this.map);
        this.map.fitBounds(bounds);

        this.placedLayers = [];
        this.placedTraps.forEach(trap => {
            let layer = trap.polygonCoordinates && trap.polygonCoordinates.trim() !== '' 
                ? this.createPolygonForPlaced(trap) 
                : (trap.x != null && trap.y != null ? this.createMarker(trap) : null);
            if (layer) this.placedLayers.push(layer);
        });

        this.setupDropZone();
    }

    async handleMarkerDragEnd(e) {
        const marker = e.target;
        const latlng = marker.getLatLng();
        const assetId = marker.assetId;

        try {
            await placeAsset({ assetId, x: latlng.lng, y: latlng.lat, recordId: this.recordId });
            this.showToast('Success', 'Asset position updated', 'success');
        } catch (err) {
            this.showToast('Error', err.body?.message || 'Update failed', 'error');
        } finally {
            await refreshApex(this.wiredMapResult);
        }
    }

    removePlacedLayer(assetId) {
        const index = this.placedLayers.findIndex(layer => layer && layer.assetId === assetId);
        if (index > -1) {
            this.map.removeLayer(this.placedLayers[index]);
            this.placedLayers.splice(index, 1);
        }
    }

    setupDropZone() {
        const container = this.map.getContainer();
        container.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        container.addEventListener('drop', e => this.handleMapDrop(e));
    }

    handleAssetDragStart(e) {
        if (this.isHeatMapReadOnly) return;
        e.dataTransfer.setData('text/plain', e.currentTarget.dataset.assetId);
    }

    async handleMapDrop(e) {
        e.preventDefault();
        if (this.isHeatMapReadOnly) return;

        const assetId = e.dataTransfer.getData('text/plain');
        if (!assetId) return;

        const rect = this.map.getContainer().getBoundingClientRect();
        const latlng = this.map.containerPointToLatLng(this.L.point(e.clientX - rect.left, e.clientY - rect.top));

        const assetIndex = this.unplacedAssets.findIndex(a => a.id === assetId);
        if (assetIndex === -1) return;

        const asset = this.unplacedAssets[assetIndex];
        this.unplacedAssets = this.unplacedAssets.filter(a => a.id !== assetId);

        const isAreaType = ['Area', 'Zone', 'Lawn Area', 'Lawn Zone'].includes(asset.deviceType || '');

        if (isAreaType) {
            this.enterDrawingMode({
                id: asset.id,
                name: asset.name,
                deviceType: asset.deviceType,
                hasFinding: asset.hasFinding || false
            });
            return;
        }

        const newTrap = {
            id: asset.id,
            name: asset.name,
            deviceType: asset.deviceType,
            x: latlng.lng,
            y: latlng.lat,
            hasFinding: asset.hasFinding || false,
            conduciveConditions: asset.conduciveConditions || []
        };

        this.placedTraps = [...this.placedTraps, newTrap];
        this.addMarkerToMap(newTrap);

        try {
            await placeAsset({ assetId, x: latlng.lng, y: latlng.lat, recordId: this.recordId });
            this.showToast('Success', 'Trap placed', 'success');
        } catch (err) {
            this.showToast('Error', err.body?.message || 'Failed to place', 'error');
        } finally {
            await refreshApex(this.wiredMapResult);
        }
    }

    addMarkerToMap(trap) {
        const marker = this.createMarker(trap);
        this.placedLayers.push(marker);
    }

    enterDrawingMode(asset) {
        this.currentDrawingAsset = asset;
        this.currentDrawingAssetName = asset.name;
        this.isDrawingMode = true;
        this.drawingPoints = [];
        this.tempPolygonLayer = null;
        this.firstPointMarker = null;

        this.map.doubleClickZoom.disable();
        this.map.on('click', this.handleMapClickForDrawing, this);
    }

    handleMapClickForDrawing(e) {
        this.drawingPoints.push(e.latlng);
        if (this.drawingPoints.length === 1) {
            this.firstPointMarker = this.L.circleMarker(e.latlng, {
                radius: 5, fillColor: '#1e40af', color: '#fff', weight: 2, fillOpacity: 1
            }).addTo(this.map);
        } else if (this.firstPointMarker) {
            this.map.removeLayer(this.firstPointMarker);
            this.firstPointMarker = null;
        }
        this.updateTempPolygonLayer();
    }

    updateTempPolygonLayer() {
        if (this.tempPolygonLayer) this.map.removeLayer(this.tempPolygonLayer);
        if (this.drawingPoints.length < 1) return;

        const style = { color: '#0ea5e9', weight: 5, opacity: 0.9, fillOpacity: this.drawingPoints.length >= 3 ? 0.18 : 0, fillColor: '#0ea5e9' };

        this.tempPolygonLayer = this.drawingPoints.length >= 3 
            ? this.L.polygon(this.drawingPoints, style).addTo(this.map)
            : this.L.polyline(this.drawingPoints, style).addTo(this.map);
    }

    finishDrawing() {
        if (this.drawingPoints.length < 3) {
            this.showToast('Error', 'You need at least 3 points to form a valid polygon.', 'error');
            return;
        }

        const polygonJson = JSON.stringify(this.drawingPoints.map(latlng => [latlng.lat, latlng.lng]));
        this.savePolygon(this.currentDrawingAsset.id, polygonJson);
        this.cleanupDrawingMode();
    }

    async savePolygon(assetId, polygonJson) {
        try {
            await savePolygonCoordinates({ assetId, polygonJson, recordId: this.recordId });
            this.showToast('Success', 'Polygon placed successfully!', 'success');
            setTimeout(() => {
                window.location.reload();
            }, 250);
        } catch (err) {
            this.showToast('Placement Error', err.body?.message || 'Could not save polygon', 'error');
        } finally {
            await refreshApex(this.wiredMapResult);
        }
    }

    cancelDrawing() {
        if (this.currentDrawingAsset) {
            this.unplacedAssets = [...this.unplacedAssets, { ...this.currentDrawingAsset }];
        }
        this.cleanupDrawingMode();
        this.showToast('Drawing Cancelled', 'No changes were saved.', 'info');
    }

    cleanupDrawingMode() {
        if (this.tempPolygonLayer) this.map.removeLayer(this.tempPolygonLayer);
        if (this.firstPointMarker) this.map.removeLayer(this.firstPointMarker);
        if (this.map) {
            this.map.off('click', this.handleMapClickForDrawing, this);
            this.map.doubleClickZoom.enable();
        }
        this.isDrawingMode = false;
        this.currentDrawingAsset = null;
        this.currentDrawingAssetName = '';
        this.drawingPoints = [];
    }

    async removeTrap(assetId) {
        if (this.isHeatMapReadOnly) {
            this.showToast('Read Only', 'You do not have permission to remove assets.', 'warning');
            return;
        }

        const trapIndex = this.placedTraps.findIndex(t => t.id === assetId);
        if (trapIndex === -1) return;

        const trap = { ...this.placedTraps[trapIndex] };
        this.placedTraps = this.placedTraps.filter(t => t.id !== assetId);

        this.unplacedAssets = [...this.unplacedAssets, {
            id: trap.id,
            name: trap.name,
            hasFinding: trap.hasFinding,
            deviceType: trap.deviceType
        }];

        this.removePlacedLayer(assetId);

        try {
            await removeAssetPlacement({ assetId, recordId: this.recordId });
            this.showToast('Trap Removed', 'Trap cleared from map and returned to palette', 'success');
        } catch (err) {
            this.showToast('Error', 'Failed to remove trap', 'error');
        } finally {
            await refreshApex(this.wiredMapResult);
        }
    }

    async refreshMap() {
        await refreshApex(this.wiredMapResult);
    }

    get unplacedAssetsWithBadge() {
        return this.unplacedAssets.map(asset => ({
            ...asset,
            badgeClass: asset.hasFinding ? 'pest-badge high' : 'pest-badge none',
            findingText: asset.hasFinding ? 'Has Finding' : 'No Finding'
        }));
    }

    handleDownloadLocally() {
        this.processExport(false);
    }

    handleOpenConverter() {
        window.open('https://smallpdf.com/pdf-converter', '_blank');
    }

    handleMenuSelect(event) {
        if (event.detail.value === 'upload') {
            this.processExport(true);
        }
    }


    handleCanvasUpload() {
        const fileInput = this.template.querySelector('input[type="file"]');
        if (fileInput) {
            fileInput.value = '';
            fileInput.click();
        }
    }

    handleFileChange(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            this.showToast('Invalid File', 'Please select an image file (PNG, JPG, JPEG, GIF, WebP, etc.).', 'error');
            return;
        }

        this.showSpinner = true;

        const reader = new FileReader();
        reader.onload = async (e) => {
            const base64Data = e.target.result.split(',')[1];

            try {
                await uploadCanvasImage({ 
                    recordId: this.recordId, 
                    base64Data: base64Data,
                    originalFileName: file.name
                });
                this.showToast('Success', `Floor plan uploaded successfully as ${file.name}!`, 'success');
                setTimeout(() => {
                    window.location.reload();
                }, 250);
                await refreshApex(this.wiredMapResult);
            } catch (err) {
                console.error('Canvas upload error:', err);
                const msg = err.body?.message || err.message || 'Unknown error';
                this.showToast('Upload Error', msg, 'error');
            } finally {
                this.showSpinner = false;
            }
        };
        reader.readAsDataURL(file);
    }

    async processExport(isUpload) {
        this.showSpinner = true;
        try {
            const mapContainer = this.template.querySelector('.map-container');
            const mapImg = this.template.querySelector('.map-container img');
            if (!mapImg) throw new Error('Map image not found');

            const base64Data = await getImageBase64({ imageUrl: mapImg.src });
            const cleanImg = new Image();
            cleanImg.src = 'data:image/png;base64,' + base64Data;
            await new Promise((resolve, reject) => {
                cleanImg.onload = resolve;
                cleanImg.onerror = () => reject(new Error('Background image failed to load'));
            });

            const canvas = document.createElement('canvas');
            canvas.width = mapContainer.offsetWidth;
            canvas.height = mapContainer.offsetHeight;
            const ctx = canvas.getContext('2d');

            const style = window.getComputedStyle(mapImg);
            const transform = new WebKitCSSMatrix(style.transform);
            ctx.drawImage(cleanImg, transform.m41, transform.m42, mapImg.offsetWidth, mapImg.offsetHeight);

            this.placedLayers.forEach(layer => {
                if (layer instanceof this.L.Polygon) {
                    const points = layer.getLatLngs()[0].map(latlng => this.map.latLngToContainerPoint(latlng));
                    const asset = this.placedTraps.find(t => t.id === layer.assetId);
                    if (asset) this.drawPolygonOnCanvas(ctx, points, asset.deviceType, asset.hasFinding, asset.name);
                } else if (layer instanceof this.L.Marker) {
                    const point = this.map.latLngToContainerPoint(layer.getLatLng());
                    const asset = this.placedTraps.find(t => t.id === layer.assetId);
                    if (asset) {
                        const { color, opacity } = this.calculateMarkerColorAndOpacity(asset.deviceType, asset.hasFinding);
                        this.drawShapeOnCanvas(ctx, asset.deviceType, point.x, point.y, color, opacity);
                        ctx.font = 'bold 10px Arial';
                        ctx.fillStyle = '#000000';
                        ctx.textAlign = 'center';
                        ctx.fillText(asset.name, point.x, point.y - 15);
                    }
                }
            });

            const dataUrl = canvas.toDataURL('image/png');
            const base64 = dataUrl.split(',')[1];
            const timestamp = new Date().toISOString().split('T')[0];
            const fileName = `HeatMap_Full_${timestamp}.png`;

            if (isUpload) {
                await uploadHeatMapImage({ recordId: this.recordId, base64Data: base64, fileName });
                this.showToast('Success', 'Full map saved to Salesforce Files ✅', 'success');
            } else {
                const link = document.createElement('a');
                link.href = dataUrl;
                link.download = fileName;
                link.click();
            }
        } catch (error) {
            console.error('Export Error:', error);
            this.showToast('Error', 'Full capture failed: ' + (error.body?.message || error.message), 'error');
        } finally {
            this.showSpinner = false;
        }
    }

    drawPolygonOnCanvas(ctx, points, deviceType, hasFinding, name) {
        if (points.length < 3) return;
        const { color } = this.calculateMarkerColorAndOpacity(deviceType, hasFinding);

        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.shadowBlur = 8;
        ctx.shadowColor = 'rgba(30, 64, 175, 0.4)';

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        let cx = 0, cy = 0;
        points.forEach(p => { cx += p.x; cy += p.y; });
        cx /= points.length;
        cy /= points.length;

        ctx.save();
        ctx.font = 'bold 11px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#1e293b';
        ctx.shadowBlur = 0;
        ctx.fillText(name, cx, cy);
        ctx.restore();
        ctx.restore();
    }

    drawShapeOnCanvas(ctx, deviceType, x, y, color, opacity) {
        const S = 10;
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.fillStyle = color;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        ctx.beginPath();

        switch (deviceType) {
            case 'ILT': ctx.moveTo(x, y - S); ctx.lineTo(x + S, y + S); ctx.lineTo(x - S, y + S); ctx.closePath(); break;
            case 'RBS': ctx.rect(x - S, y - S * 0.6, S * 2, S * 1.2); break;
            case 'IRT/ET':
            case 'WT':
            case 'MISC': ctx.rect(x - S, y - S, S * 2, S * 2); break;
            case 'MLS':
            case 'Zone':
            case 'Area':
            case 'Lawn Zone':
            case 'Lawn Area': ctx.arc(x, y, S, 0, Math.PI * 2); break;
            case 'TBS':
                for (let i = 0; i < 8; i++) {
                    const angle = (i * Math.PI / 4) - (Math.PI / 8);
                    ctx.lineTo(x + S * Math.cos(angle), y + S * Math.sin(angle));
                }
                ctx.closePath();
                break;
            case 'FBS': ctx.ellipse(x, y, S, S * 0.55, 0, 0, Math.PI * 2); break;
            case 'PHT': ctx.moveTo(x, y - S); ctx.lineTo(x + S, y); ctx.lineTo(x, y + S); ctx.lineTo(x - S, y); ctx.closePath(); break;
            case 'Logbook':
                for (let i = 0; i < 10; i++) {
                    const angle = (i * Math.PI / 5) - (Math.PI / 2);
                    const r = i % 2 === 0 ? S : S * 0.4;
                    ctx.lineTo(x + r * Math.cos(angle), y + r * Math.sin(angle));
                }
                ctx.closePath();
                break;
            default: ctx.arc(x, y, S * 0.8, 0, Math.PI * 2);
        }

        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}