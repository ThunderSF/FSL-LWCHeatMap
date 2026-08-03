public with sharing class abcHeatMapController {

    public class MapAsset {
        @AuraEnabled public String id;
        @AuraEnabled public String name;
        @AuraEnabled public Decimal x;           
        @AuraEnabled public Decimal y;
        @AuraEnabled public Boolean hasFinding;
        @AuraEnabled public String deviceType;          
        @AuraEnabled public String polygonCoordinates; 
        @AuraEnabled public List<Conducive_Condition__c> conduciveConditions;
    }

    public class LocationMapData {
        @AuraEnabled public String imageUrl;
        @AuraEnabled public List<MapAsset> placedAssets;
        @AuraEnabled public List<MapAsset> unplacedAssets;
    }

    private static Set<Id> getHierarchyLocationIds(Id rootId) {
        Set<Id> hierarchyIds = new Set<Id>{rootId};
        collectChildLocations(rootId, hierarchyIds);
        return hierarchyIds;
    }

    private static void collectChildLocations(Id parentId, Set<Id> allIds) {
        List<Schema.Location> children = [SELECT Id FROM Location WHERE ParentLocationId = :parentId];
        for (Schema.Location child : children) {
            allIds.add(child.Id);
            collectChildLocations(child.Id, allIds);
        }
    }

    @AuraEnabled(cacheable=true)
    public static LocationMapData getLocationMapDetails(Id recordId) {
        Set<Id> hierarchyIds = getHierarchyLocationIds(recordId);

        List<ContentDocumentLink> cdlList = [SELECT Id, ContentDocumentId 
                                   FROM ContentDocumentLink 
                                   WHERE LinkedEntityId = :recordId 
                                    AND ContentDocument.Title = 'HEAT_MAP_BACKGROUND'
                                    ORDER BY SystemModstamp DESC
                                    LIMIT 1];

        String imageUrl = null;
        if (!cdlList.isEmpty()) {
            ContentVersion cv = [SELECT Id, VersionData 
                                 FROM ContentVersion 
                                 WHERE ContentDocumentId = :cdlList[0].ContentDocumentId 
                                 AND IsLatest = true LIMIT 1];
            imageUrl = '/sfc/servlet.shepherd/version/download/' + cv.Id;
        }

        List<Asset> assets = [SELECT Id, Name, X_Coordinate__c, Y_Coordinate__c, Type__c,
                                     Polygon_Coordinates__c, Placed_at_Location__c,
            (SELECT Id, Name, Description__c FROM Conducive_Conditions__r ORDER BY CreatedDate DESC)
            FROM Asset 
            WHERE LocationId IN :hierarchyIds
            ORDER BY Name];

        Map<Id, Boolean> assetHasFinding = new Map<Id, Boolean>();
        for (AggregateResult ar : [SELECT Asset__c FROM Finding__c WHERE Asset__c IN :assets GROUP BY Asset__c]) {
            assetHasFinding.put((Id)ar.get('Asset__c'), true);
        }

        List<MapAsset> placed = new List<MapAsset>();
        List<MapAsset> unplaced = new List<MapAsset>();

        for (Asset a : assets) {
            Boolean hasFinding = assetHasFinding.containsKey(a.Id);

            MapAsset ma = new MapAsset();
            ma.id = a.Id;
            ma.name = a.Name;
            ma.x = a.X_Coordinate__c;
            ma.y = a.Y_Coordinate__c;
            ma.hasFinding = hasFinding;
            ma.deviceType = a.Type__c;
            ma.polygonCoordinates = a.Polygon_Coordinates__c;
            ma.conduciveConditions = a.Conducive_Conditions__r;

            Boolean isPlacedAtThisLocation = (a.Placed_at_Location__c == recordId) ||
                (a.Placed_at_Location__c == null && 
                 (a.X_Coordinate__c != null || a.Y_Coordinate__c != null || String.isNotBlank(a.Polygon_Coordinates__c)));

            if (isPlacedAtThisLocation) {
                placed.add(ma);
            } else if (a.Placed_at_Location__c == null) {
                unplaced.add(ma);
            }
        }

        LocationMapData data = new LocationMapData();
        data.imageUrl = imageUrl;
        data.placedAssets = placed;
        data.unplacedAssets = unplaced;
        return data;
    }

    @AuraEnabled
    public static void placeAsset(Id assetId, Decimal x, Decimal y, Id recordId) {
        Asset a = new Asset(Id = assetId, X_Coordinate__c = x, Y_Coordinate__c = y, Placed_at_Location__c = recordId);
        update a;
    }

    @AuraEnabled
    public static void removeAssetPlacement(Id assetId, Id recordId) {
        Asset a = new Asset(Id = assetId, X_Coordinate__c = null, Y_Coordinate__c = null, Polygon_Coordinates__c = null, Placed_at_Location__c = null);
        update a;
    }

    @AuraEnabled
    public static void savePolygonCoordinates(Id assetId, String polygonJson, Id recordId) {
        Asset a = new Asset(Id = assetId, Polygon_Coordinates__c = polygonJson, Placed_at_Location__c = recordId);
        update a;
    }

    @AuraEnabled
    public static void uploadHeatMapImage(Id recordId, String base64Data, String fileName) {
        try {
            ContentVersion cv = new ContentVersion();
            cv.Title = fileName;
            cv.PathOnClient = fileName + '.png';
            cv.VersionData = EncodingUtil.base64Decode(base64Data);
            cv.IsMajorVersion = true;
            insert cv;

            Id conDocId = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id].ContentDocumentId;

            ContentDocumentLink cdl = new ContentDocumentLink();
            cdl.ContentDocumentId = conDocId;
            cdl.LinkedEntityId = recordId;
            cdl.ShareType = 'V';
            insert cdl;
        } catch (Exception e) {
            throw new AuraHandledException('Error uploading image: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static String getImageBase64(String imageUrl) {
        try {
            if (imageUrl.contains('version/download/')) {
                String cvId = imageUrl.substringAfter('version/download/');
                if (cvId.contains('?')) cvId = cvId.substringBefore('?');
                ContentVersion cv = [SELECT VersionData FROM ContentVersion WHERE Id = :cvId LIMIT 1];
                return EncodingUtil.base64Encode(cv.VersionData);
            }
            throw new AuraHandledException('Invalid image URL');
        } catch (Exception e) {
            throw new AuraHandledException('Apex Proxy failed: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static void uploadCanvasImage(Id recordId, String base64Data, String originalFileName) {
        try {
            String title = 'HEAT_MAP_BACKGROUND';
            String pathOnClient = String.isNotBlank(originalFileName) ? originalFileName : 'HEAT_MAP_BACKGROUND.png';

            List<ContentDocumentLink> existingLinks = [SELECT ContentDocumentId 
                FROM ContentDocumentLink 
                WHERE LinkedEntityId = :recordId 
                AND ContentDocument.Title = :title LIMIT 1];

            if (!existingLinks.isEmpty()) {
                delete [SELECT Id FROM ContentDocument WHERE Id = :existingLinks[0].ContentDocumentId];
            }

            ContentVersion cv = new ContentVersion();
            cv.Title = title;
            cv.PathOnClient = pathOnClient;
            cv.VersionData = EncodingUtil.base64Decode(base64Data);
            cv.IsMajorVersion = true;
            insert cv;

            Id conDocId = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id].ContentDocumentId;

            ContentDocumentLink cdl = new ContentDocumentLink();
            cdl.ContentDocumentId = conDocId;
            cdl.LinkedEntityId = recordId;
            cdl.ShareType = 'V';
            insert cdl;

        } catch (Exception e) {
            throw new AuraHandledException('Floor plan upload failed: ' + e.getMessage());
        }
    }
}