const NodeHelper = require("node_helper");
const Log = require("logger");
const https = require("https");
const fs = require("fs");
const path = require("path");
const exif = require("exif-parser");

/**
 * Modern Node Helper for MMM-RandomPhoto
 * Focused on Nextcloud integration with proper error handling
 * No express app dependency
 */
module.exports = NodeHelper.create({
    
    start: function() {
        Log.info(`[${this.name}] Node helper started`);
        this.config = null;
        this.imageCache = new Map(); // Cache for image data
        this.isInitialized = false;
    },

    socketNotificationReceived: function(notification, payload) {
        Log.debug(`[${this.name}] Received notification: ${notification}`);
        
        switch (notification) {
            case "INIT_CONFIG":
                this.handleConfigInit(payload);
                break;
            case "FETCH_IMAGE_LIST":
                this.fetchImageList();
                break;
            case "FETCH_IMAGE":
                this.fetchImageData(payload);
                break;
            default:
                Log.warn(`[${this.name}] Unknown notification: ${notification}`);
        }
    },

    handleConfigInit: function(config) {
        try {
            this.config = { ...config };
            this.isInitialized = true;
            Log.info(`[${this.name}] Configuration initialized successfully`);
            
            // Validate essential configuration
            this.validateConfiguration();
        } catch (error) {
            Log.error(`[${this.name}] Failed to initialize configuration: ${error.message}`);
            this.sendSocketNotification("ERROR", { 
                message: "Configuration initialization failed",
                details: error.message 
            });
        }
    },

    validateConfiguration: function() {
        if (!this.config.repositoryConfig?.path) {
            throw new Error("No repository path configured");
        }

        if (!this.config.repositoryConfig?.username || !this.config.repositoryConfig?.password) {
            throw new Error("No authentication credentials provided");
        }

        try {
            new URL(this.config.repositoryConfig.path);
        } catch (error) {
            throw new Error(`Invalid repository URL: ${this.config.repositoryConfig.path}`);
        }
    },

    fetchImageList: function() {
        if (!this.isInitialized) {
            Log.error(`[${this.name}] Helper not initialized, cannot fetch image list`);
            return;
        }

        Log.info(`[${this.name}] Fetching image list from Nextcloud...`);
        this.sendSocketNotification("FETCH_PROGRESS", { message: "Connecting to Nextcloud..." });

        const url = this.config.repositoryConfig.path;
        const auth = this.createAuthHeader();
        
        const requestOptions = {
            method: "PROPFIND",
            headers: {
                "Authorization": auth,
                "Depth": this.config.repositoryConfig.recursive ? "infinity" : "1",
                "Content-Type": "application/xml"
            },
            timeout: 30000 // 30 second timeout
        };

        const request = https.request(url, requestOptions, (response) => {
            this.handleImageListResponse(response);
        });

        request.on("error", (error) => {
            Log.error(`[${this.name}] Network error while fetching image list: ${error.message}`);
            this.sendSocketNotification("ERROR", { 
                message: "Failed to connect to Nextcloud",
                details: error.message 
            });
        });

        request.on("timeout", () => {
            Log.error(`[${this.name}] Request timeout while fetching image list`);
            request.destroy();
            this.sendSocketNotification("ERROR", { 
                message: "Request timeout - Nextcloud server not responding" 
            });
        });

        request.end();
    },

    handleImageListResponse: function(response) {
        let body = "";
        
        response.on("data", (chunk) => {
            body += chunk;
        });

        response.on("end", () => {
            try {
                if (response.statusCode >= 400) {
                    throw new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`);
                }

                const imageList = this.parseImageListFromResponse(body);
                
                if (imageList.length === 0) {
                    Log.warn(`[${this.name}] No images found in the specified path`);
                    this.sendSocketNotification("ERROR", { 
                        message: "No images found in the specified Nextcloud path" 
                    });
                    return;
                }

                Log.info(`[${this.name}] Successfully found ${imageList.length} images`);
                this.sendSocketNotification("IMAGE_LIST_RECEIVED", imageList);
                
            } catch (error) {
                Log.error(`[${this.name}] Failed to parse image list: ${error.message}`);
                this.sendSocketNotification("ERROR", { 
                    message: "Failed to parse Nextcloud response",
                    details: error.message 
                });
            }
        });

        response.on("error", (error) => {
            Log.error(`[${this.name}] Response error: ${error.message}`);
            this.sendSocketNotification("ERROR", { 
                message: "Error receiving data from Nextcloud",
                details: error.message 
            });
        });
    },

    parseImageListFromResponse: function(responseBody) {
        try {
            // Extract href entries from WebDAV response
            const hrefMatches = responseBody.match(/href>([^<]+)</g);
            
            if (!hrefMatches) {
                Log.warn(`[${this.name}] No href entries found in response`);
                return [];
            }

            const baseUrl = new URL(this.config.repositoryConfig.path);
            const basePath = baseUrl.pathname;
            
            const imageList = [];
            const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif'];
            const excludePatterns = this.config.repositoryConfig.exclude?.map(pattern => new RegExp(pattern, 'i')) || [];

            for (let match of hrefMatches) {
                const href = match.replace(/href>([^<]+)</, '$1');
                
                // Skip if it's the current directory
                if (href === basePath || href === basePath + '/') {
                    continue;
                }

                // Extract filename
                const filename = decodeURIComponent(href.replace(basePath, '').replace(/^\/+/, ''));
                
                // Skip if empty or is a directory (ends with /)
                if (!filename || filename.endsWith('/')) {
                    continue;
                }

                // Check if it's an image file
                const ext = path.extname(filename).toLowerCase();
                if (!imageExtensions.includes(ext)) {
                    continue;
                }

                // Apply exclude patterns
                if (excludePatterns.some(pattern => pattern.test(filename))) {
                    Log.debug(`[${this.name}] Excluding file due to exclude pattern: ${filename}`);
                    continue;
                }

                imageList.push(filename);
            }

            return imageList;
            
        } catch (error) {
            Log.error(`[${this.name}] Error parsing image list: ${error.message}`);
            return [];
        }
    },

    fetchImageData: function(imageRequest) {
        const { filename, index } = imageRequest;
        
        Log.debug(`[${this.name}] Fetching image data for: ${filename}`);
        
        // Check cache first
        const cacheKey = `${filename}_${this.config.showWidth}_${this.config.showHeight}`;
        if (this.imageCache.has(cacheKey)) {
            Log.debug(`[${this.name}] Returning cached image data for: ${filename}`);
            this.sendSocketNotification("IMAGE_DATA_RECEIVED", this.imageCache.get(cacheKey));
            return;
        }

        const imageUrl = this.config.repositoryConfig.path + "/" + encodeURIComponent(filename);
        const auth = this.createAuthHeader();

        const requestOptions = {
            method: "GET",
            headers: {
                "Authorization": auth
            },
            timeout: 60000 // 60 second timeout for image download
        };

        const request = https.request(imageUrl, requestOptions, (response) => {
            this.handleImageDataResponse(response, filename, cacheKey);
        });

        request.on("error", (error) => {
            Log.error(`[${this.name}] Error fetching image ${filename}: ${error.message}`);
            this.sendSocketNotification("ERROR", { 
                message: `Failed to fetch image: ${filename}`,
                details: error.message 
            });
        });

        request.on("timeout", () => {
            Log.error(`[${this.name}] Timeout fetching image: ${filename}`);
            request.destroy();
            this.sendSocketNotification("ERROR", { 
                message: `Timeout downloading image: ${filename}` 
            });
        });

        request.end();
    },

    handleImageDataResponse: function(response, filename, cacheKey) {
        if (response.statusCode >= 400) {
            Log.error(`[${this.name}] HTTP error ${response.statusCode} for image: ${filename}`);
            this.sendSocketNotification("ERROR", { 
                message: `Failed to download image: ${filename} (HTTP ${response.statusCode})` 
            });
            return;
        }

        const chunks = [];
        
        response.on("data", (chunk) => {
            chunks.push(chunk);
        });

        response.on("end", () => {
            try {
                const buffer = Buffer.concat(chunks);
                const mimeType = response.headers["content-type"] || "image/jpeg";
                const encodedData = `data:${mimeType};base64,${buffer.toString('base64')}`;
                
                // Extract EXIF data
                const exifData = this.extractExifData(buffer);
                
                const imageData = {
                    filename: filename,
                    encodedData: encodedData,
                    exifData: exifData,
                    mimeType: mimeType,
                    size: buffer.length
                };

                // Cache the result (limit cache size to prevent memory issues)
                if (this.imageCache.size > 50) {
                    const firstKey = this.imageCache.keys().next().value;
                    this.imageCache.delete(firstKey);
                }
                this.imageCache.set(cacheKey, imageData);

                Log.debug(`[${this.name}] Successfully processed image: ${filename} (${Math.round(buffer.length / 1024)}KB)`);
                this.sendSocketNotification("IMAGE_DATA_RECEIVED", imageData);
                
            } catch (error) {
                Log.error(`[${this.name}] Error processing image ${filename}: ${error.message}`);
                this.sendSocketNotification("ERROR", { 
                    message: `Failed to process image: ${filename}`,
                    details: error.message 
                });
            }
        });

        response.on("error", (error) => {
            Log.error(`[${this.name}] Error downloading image ${filename}: ${error.message}`);
            this.sendSocketNotification("ERROR", { 
                message: `Download error for image: ${filename}`,
                details: error.message 
            });
        });
    },

    extractExifData: function(buffer) {
        const exifData = {
            date: null,
            location: null,
            camera: null,
            coordinates: null
        };

        try {
            const parser = exif.create(buffer);
            const result = parser.parse();
            
            if (result && result.tags) {
                const tags = result.tags;
                
                // Extract date information
                if (tags.DateTimeOriginal) {
                    const dateObj = new Date(tags.DateTimeOriginal * 1000);
                    exifData.date = dateObj.toISOString();
                }

                // Extract GPS coordinates
                if (tags.GPSLatitude && tags.GPSLongitude) {
                    exifData.coordinates = {
                        latitude: tags.GPSLatitude,
                        longitude: tags.GPSLongitude
                    };
                    
                    // Reverse geocoding to get location name (only if enabled)
                    if (this.config.enableGeocoding) {
                        this.reverseGeocode(tags.GPSLatitude, tags.GPSLongitude)
                            .then(location => {
                                exifData.location = location;
                            })
                            .catch(error => {
                                Log.debug(`[${this.name}] Reverse geocoding failed: ${error.message}`);
                            });
                    } else {
                        Log.debug(`[${this.name}] Geocoding disabled - GPS coordinates extracted but no location lookup performed`);
                    }
                }

                // Extract camera information
                if (tags.Make || tags.Model) {
                    const make = tags.Make || "";
                    const model = tags.Model || "";
                    exifData.camera = `${make} ${model}`.trim();
                }
            }
        } catch (error) {
            Log.debug(`[${this.name}] EXIF extraction failed (this is normal for some images): ${error.message}`);
        }

        return exifData;
    },

    async reverseGeocode(latitude, longitude) {
        return new Promise((resolve, reject) => {
            const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10&addressdetails=1`;
            
            https.get(url, { timeout: 5000 }, (response) => {
                let body = "";
                
                response.on("data", (chunk) => {
                    body += chunk;
                });
                
                response.on("end", () => {
                    try {
                        const data = JSON.parse(body);
                        const address = data.address || {};
                        
                        // Try to get the best available location name
                        const location = address.city || 
                                       address.town || 
                                       address.village || 
                                       address.hamlet || 
                                       address.suburb || 
                                       address.neighbourhood ||
                                       address.county ||
                                       address.state ||
                                       address.country ||
                                       null;
                        
                        if (location) {
                            resolve(location);
                        } else {
                            reject(new Error("No location found"));
                        }
                    } catch (error) {
                        reject(new Error(`Failed to parse geocoding response: ${error.message}`));
                    }
                });
            }).on("error", reject).on("timeout", () => {
                reject(new Error("Geocoding request timeout"));
            });
        });
    },

    createAuthHeader: function() {
        const credentials = `${this.config.repositoryConfig.username}:${this.config.repositoryConfig.password}`;
        return `Basic ${Buffer.from(credentials).toString('base64')}`;
    },

    stop: function() {
        Log.info(`[${this.name}] Node helper stopping...`);
        
        // Clear cache
        if (this.imageCache) {
            this.imageCache.clear();
        }
        
        // Reset state
        this.config = null;
        this.isInitialized = false;
    }
});