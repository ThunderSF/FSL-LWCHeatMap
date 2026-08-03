@isTest
private class abcHeatMapControllerTest {

    @TestSetup
    static void setupData() {
        Account acc = new Account(
            Name = 'Test Account'
        );
        insert acc;

        Schema.Location rootLoc = new Schema.Location(Name = 'Root Building', LocationType = 'Building');
        insert rootLoc;

        Schema.Location floor1 = new Schema.Location(Name = 'Floor 1', ParentLocationId = rootLoc.Id, LocationType = 'Floor');
        insert floor1;

        List<Asset> assets = new List<Asset>{
            new Asset(Name = 'Placed Asset', AccountId = acc.Id, LocationId = floor1.Id, X_Coordinate__c = 10.5, Y_Coordinate__c = 20.0),
            new Asset(Name = 'Unplaced Asset', AccountId = acc.Id, LocationId = floor1.Id)
        };
        insert assets;

        insert new Finding__c(Asset__c = assets[0].Id, Type__c = 'Capture');
        insert new Conducive_Condition__c(Asset__c = assets[0].Id, Description__c = 'Spillage');

        ContentVersion cv = new ContentVersion(
            Title = 'HEAT_MAP_BACKGROUND',
            PathOnClient = 'map.png',
            VersionData = Blob.valueOf('Initial Data')
        );
        insert cv;

        Id conDocId = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id].ContentDocumentId;
        insert new ContentDocumentLink(ContentDocumentId = conDocId, LinkedEntityId = rootLoc.Id, ShareType = 'V');
    }

    @isTest
    static void testGetLocationMapDetails() {
        Schema.Location root = [SELECT Id FROM Location WHERE Name = 'Root Building' LIMIT 1];
        
        Test.startTest();
        abcHeatMapController.LocationMapData data = abcHeatMapController.getLocationMapDetails(root.Id);
        Test.stopTest();

        Assert.isNotNull(data, 'Should return a valid data wrapper');
        Assert.isFalse(data.placedAssets.isEmpty(), 'Should contain assets from hierarchy');
    }

    @isTest
    static void testAssetPlacementOperations() {
        Asset unplaced = [SELECT Id FROM Asset WHERE Name = 'Unplaced Asset' LIMIT 1];
        Schema.Location root = [SELECT Id FROM Location WHERE Name = 'Root Building' LIMIT 1];

        Test.startTest();
        abcHeatMapController.placeAsset(unplaced.Id, 55.5, 66.6, root.Id);
        abcHeatMapController.savePolygonCoordinates(unplaced.Id, '[1,2,3]', root.Id);
        abcHeatMapController.removeAssetPlacement(unplaced.Id, root.Id);
        Test.stopTest();

        Asset result = [SELECT X_Coordinate__c, Polygon_Coordinates__c FROM Asset WHERE Id = :unplaced.Id];
        Assert.isNull(result.X_Coordinate__c, 'X coordinate should be cleared');
        Assert.isNull(result.Polygon_Coordinates__c, 'Polygon data should be cleared');
    }

    @isTest
    static void testImageManagement() {
        Schema.Location root = [SELECT Id FROM Location WHERE Name = 'Root Building' LIMIT 1];
        String base64Data = EncodingUtil.base64Encode(Blob.valueOf('Updated Content'));

        Test.startTest();
        abcHeatMapController.uploadCanvasImage(root.Id, base64Data, 'new_map.png');
        
        ContentVersion latestCv = [SELECT Id FROM ContentVersion WHERE Title = 'HEAT_MAP_BACKGROUND' AND IsLatest = true LIMIT 1];
        String resultBase64 = abcHeatMapController.getImageBase64('/sfc/servlet.shepherd/version/download/' + latestCv.Id);
        Test.stopTest();

        Assert.areEqual(base64Data, resultBase64, 'Base64 data mismatch after upload');
    }

    @isTest
    static void testUploadHeatMapImageSuccess() {
        Schema.Location root = [SELECT Id FROM Location WHERE Name = 'Root Building' LIMIT 1];
        String base64Data = EncodingUtil.base64Encode(Blob.valueOf('Test'));
        
        Test.startTest();
        abcHeatMapController.uploadHeatMapImage(root.Id, base64Data, 'Manual_Upload');
        Test.stopTest();

        ContentVersion cv = [SELECT Title FROM ContentVersion WHERE Title = 'Manual_Upload' LIMIT 1];
        Assert.isNotNull(cv, 'ContentVersion should be created');
    }

    @isTest
    static void testExceptionHandling() {
        Test.startTest();
        try {
            abcHeatMapController.uploadHeatMapImage(null, '!!!', 'ErrorTest');
            Assert.fail('Should have thrown an AuraHandledException');
        } catch (AuraHandledException e) {
            Assert.isNotNull(e.getMessage());
        }

        try {
            abcHeatMapController.getImageBase64('/invalid/url');
            Assert.fail('Should have thrown an AuraHandledException');
        } catch (AuraHandledException e) {
            Assert.isNotNull(e.getMessage());
        }
        Test.stopTest();
    }
}