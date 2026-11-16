# Trimmed whitelist for device-mapping-core's actual OpenCV.js usage.
# Source of truth: grep -on "cv\.[A-Za-z_][A-Za-z0-9_]*" src/components/device-mapping-core/feature-matcher.js
#
# Modules kept: core, imgproc (cvtColor + CLAHE only), features2d (ORB/BFMatcher),
# calib3d (solvePnP family + findEssentialMat/recoverPose/findHomography + Rodrigues/projectPoints).
# Everything else (dnn, objdetect, photo, video, ml, stitching, gapi, videoio, highgui) is dropped.

core = {
    '': [
        'setLogLevel', 'getLogLevel',
    ],
    'Algorithm': [],
}

imgproc = {
    '': [
        'cvtColor',
        'createCLAHE',
    ],
    'CLAHE': ['apply', 'collectGarbage', 'getClipLimit', 'getTilesGridSize', 'setClipLimit', 'setTilesGridSize'],
}

features2d = {
    'Feature2D': ['detect', 'compute', 'detectAndCompute', 'descriptorSize', 'descriptorType', 'defaultNorm', 'empty', 'getDefaultName'],
    'ORB': ['create', 'setMaxFeatures', 'setScaleFactor', 'setNLevels', 'setEdgeThreshold', 'setFastThreshold', 'setFirstLevel', 'setWTA_K', 'setScoreType', 'setPatchSize', 'getFastThreshold', 'getDefaultName'],
    'DescriptorMatcher': ['add', 'clear', 'empty', 'isMaskSupported', 'train', 'match', 'knnMatch', 'radiusMatch', 'clone', 'create'],
    'BFMatcher': ['isMaskSupported', 'create'],
}

calib3d = {
    '': [
        'findHomography',
        'Rodrigues',
        'solvePnP',
        'solvePnPRansac',
        'projectPoints',
        'findEssentialMat',
        'recoverPose',
    ],
}

white_list = makeWhiteList([core, imgproc, features2d, calib3d])
