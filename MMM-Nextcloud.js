/* global Module */

/* MagicMirror²
 * Module: MMM-Nextcloud
 *
 * Modern implementation focused on Nextcloud integration
 * Using vanilla JavaScript, no jQuery dependency
 */
Module.register("MMM-Nextcloud", {
    defaults: {
        opacity: 0.3, // Main photo opacity
        backgroundOpacity: 1.0, // Opacity for blurred background image (0.0 - 1.0)
        animationSpeed: 500,
        updateInterval: 60, // Seconds between photo changes
        listRefreshInterval: 3600, // Seconds between photo list refreshes (1 hour)
        repositoryConfig: {
            path: "", // Nextcloud WebDAV URL
            username: "",
            password: "",
            recursive: false,
            exclude: [], // Array of regex patterns to exclude files
        },
        width: 400,
        height: 400,
        showWidth: 400, // Used for display quality
        showHeight: 400,
        random: true,
        grayscale: false,
        blur: false,
        blurAmount: 1,
        startHidden: false,
        startPaused: false,
        showStatusIcon: true,
        statusIconMode: "show", // "show", "fade"
        statusIconPosition: "top_right", // "top_right", "top_left", "bottom_right", "bottom_left"
        showExifData: true,
        enableGeocoding: true, // Enable reverse geocoding for GPS coordinates to location names
        showOsmAttribution: true, // Show OpenStreetMap attribution when location data is displayed
        dateFormat: {  // Custom date format for EXIF data display
            year: 'numeric', 
            month: 'long', 
            day: '2-digit' 
        }
    },

    start: function() {
        Log.info(`[${this.name}] Starting module...`);
        
        this.updateTimer = null;
        this.refreshTimer = null;
        this.imageList = [];
        this.currentImageIndex = -1;
        this.running = false;
        this.currentImageUrl = null;
        this.animationInProgress = false;

        // Validate configuration
        this.validateConfig();

        // Set blur amount to max of 10px
        if (this.config.blurAmount > 10) { 
            this.config.blurAmount = 10; 
        }

        // Send initial configuration to node helper
        this.sendSocketNotification('INIT_CONFIG', this.config);
        
        // Request initial image list
        this.requestImageList();
    },

    validateConfig: function() {
        if (!this.config.repositoryConfig.path) {
            Log.error(`[${this.name}] No repository path configured. Please set repositoryConfig.path`);
            return;
        }

        if (!this.config.repositoryConfig.username || !this.config.repositoryConfig.password) {
            Log.error(`[${this.name}] No credentials configured. Please set repositoryConfig.username and repositoryConfig.password`);
            return;
        }

        // Validate status icon position
        const validPositions = ['top_right', 'top_left', 'bottom_right', 'bottom_left'];
        if (!validPositions.includes(this.config.statusIconPosition)) {
            Log.warn(`[${this.name}] Invalid statusIconPosition. Using default 'top_right'`);
            this.config.statusIconPosition = 'top_right';
        }

        // Ensure minimum intervals
        if (this.config.updateInterval < 10) {
            Log.warn(`[${this.name}] updateInterval too low. Setting to minimum of 10 seconds`);
            this.config.updateInterval = 10;
        }

        if (this.config.listRefreshInterval < 300) {
            Log.warn(`[${this.name}] listRefreshInterval too low. Setting to minimum of 300 seconds`);
            this.config.listRefreshInterval = 300;
        }
    },

    requestImageList: function() {
        Log.info(`[${this.name}] Requesting image list from Nextcloud...`);
        this.sendSocketNotification('FETCH_IMAGE_LIST');
    },

    setupRefreshTimer: function() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }

        this.refreshTimer = setInterval(() => {
            Log.info(`[${this.name}] Refreshing image list...`);
            this.requestImageList();
        }, this.config.listRefreshInterval * 1000);
    },

    pauseImageLoading: function() {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        this.running = false;
        
        if (this.config.showStatusIcon) {
            this.updateStatusIcon();
        }
        
        Log.info(`[${this.name}] Image loading paused`);
    },

    resumeImageLoading: function(respectPausedState = false) {
        if (!this.running || !respectPausedState) {
            if (respectPausedState && this.config.startPaused) {
                this.running = false;
                return;
            }
            
            this.running = true;
            this.loadNextImage();
            
            if (this.config.showStatusIcon) {
                this.updateStatusIcon();
            }
            
            Log.info(`[${this.name}] Image loading resumed`);
        }
    },

    loadNextImage: function(direction = "next") {
        if (this.animationInProgress) {
            Log.debug(`[${this.name}] Animation in progress, skipping load request`);
            return;
        }

        if (!this.imageList || this.imageList.length === 0) {
            Log.warn(`[${this.name}] No images available to display`);
            this.scheduleNextUpdate();
            return;
        }

        const imageData = this.getNextImageFromList(direction);
        if (!imageData) {
            Log.error(`[${this.name}] Failed to get image from list`);
            this.scheduleNextUpdate();
            return;
        }

        Log.debug(`[${this.name}] Loading image: ${imageData.filename}`);
        this.sendSocketNotification('FETCH_IMAGE', imageData);
    },

    getNextImageFromList: function(direction = "next") {
        if (!this.imageList || this.imageList.length === 0) {
            return null;
        }

        let targetIndex = this.currentImageIndex;

        if (this.config.random) {
            // Ensure we don't show the same image twice in a row (unless only one image)
            do {
                targetIndex = Math.floor(Math.random() * this.imageList.length);
            } while (this.imageList.length > 1 && targetIndex === this.currentImageIndex);
        } else {
            if (direction === "previous") {
                targetIndex--;
                if (targetIndex < 0) {
                    targetIndex = this.imageList.length - 1;
                }
            } else {
                targetIndex++;
                if (targetIndex >= this.imageList.length) {
                    targetIndex = 0;
                }
            }
        }

        this.currentImageIndex = targetIndex;
        return {
            filename: this.imageList[targetIndex],
            index: targetIndex
        };
    },

    displayImage: function(imageData) {
        if (this.animationInProgress) {
            return;
        }

        this.animationInProgress = true;
        
        // Create new image element to preload
        const tempImg = document.createElement('img');
        
        tempImg.onload = () => {
            this.performImageTransition(imageData);
        };
        
        tempImg.onerror = (error) => {
            Log.error(`[${this.name}] Failed to load image: ${error}`);
            this.animationInProgress = false;
            this.scheduleNextUpdate();
        };
        
        tempImg.src = imageData.encodedData;
    },

    performImageTransition: function(imageData) {
        const mainImage = document.getElementById("nextcloud-main-image");
        const backgroundImage = document.getElementById("nextcloud-background-blur");
        
        if (!mainImage) {
            Log.error(`[${this.name}] Main image element not found`);
            this.animationInProgress = false;
            return;
        }

        // Update background blur image if blur is enabled
        if (this.config.blur && backgroundImage) {
            backgroundImage.src = imageData.encodedData;
            this.updateBackgroundFilters(backgroundImage);
        }

        // Animate main image transition
        mainImage.style.opacity = '0';
        
        setTimeout(() => {
            mainImage.src = imageData.encodedData;
            this.updateMainImageFilters(mainImage);
            
            // Fade in new image
            mainImage.style.transition = `opacity ${this.config.animationSpeed}ms ease-in-out`;
            mainImage.style.opacity = this.config.opacity;
            
            // Update EXIF information
            if (this.config.showExifData && imageData.exifData) {
                this.updateExifDisplay(imageData.exifData);
            } else {
                this.hideExifDisplay();
            }
            
            this.currentImageUrl = imageData.encodedData;
            this.animationInProgress = false;
            this.scheduleNextUpdate();
            
        }, this.config.animationSpeed / 2);
    },

    updateMainImageFilters: function(imageElement) {
        let filters = [];
        
        if (this.config.grayscale) {
            filters.push('grayscale(100%)');
        }
        
        imageElement.style.filter = filters.join(' ');
    },

    updateBackgroundFilters: function(backgroundElement) {
        // Instagram-style blur effect with enhanced filters
        let filters = [
            'blur(25px)',
            'brightness(0.6)',
            'saturate(1.4)',
            'contrast(1.1)',
            'hue-rotate(5deg)'
        ];
        
        if (this.config.grayscale) {
            filters.push('grayscale(100%)');
        }
        
        // Apply Instagram-like color grading
        backgroundElement.style.filter = filters.join(' ');
        backgroundElement.style.opacity = this.config.backgroundOpacity * 0.8; // Slightly more transparent for better effect
    },

    updateExifDisplay: function(exifData) {
        const exifContainer = document.getElementById("nextcloud-exif-data");
        if (!exifContainer) return;

        let exifText = "";
        let hasLocationData = false;
        
        if (exifData.date) {
            exifText += this.formatExifDate(exifData.date);
        }
        
        if (exifData.location) {
            if (exifText) exifText += ", ";
            exifText += exifData.location;
            hasLocationData = true;
        }

        if (exifText) {
            // Clear previous content
            exifContainer.innerHTML = "";
            
            // Main EXIF text
            const mainText = document.createElement("span");
            mainText.textContent = exifText;
            exifContainer.appendChild(mainText);
            
            // Add OSM attribution if location data is shown (from geocoding) and attribution is enabled
            if (hasLocationData && this.config.enableGeocoding && this.config.showOsmAttribution) {
                const attribution = document.createElement("div");
                attribution.className = "nextcloud-osm-attribution";
                attribution.innerHTML = 'Location data © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
                attribution.style.fontSize = "0.7em";
                attribution.style.opacity = "0.8";
                attribution.style.marginTop = "2px";
                exifContainer.appendChild(attribution);
            }
            
            exifContainer.style.display = "block";
        } else {
            this.hideExifDisplay();
        }
    },

    formatExifDate: function(dateString) {
        try {
            // Parse the date and format according to user preference
            const date = new Date(dateString);
            if (isNaN(date.getTime())) {
                return dateString; // Return original if parsing fails
            }
            
            // Simple date formatting - could be enhanced with moment.js alternative
            return date.toLocaleDateString(config.locale, this.config.dateFormat);
        } catch (error) {
            Log.warn(`[${this.name}] Failed to format date: ${dateString}`);
            return dateString;
        }
    },

    hideExifDisplay: function() {
        const exifContainer = document.getElementById("nextcloud-exif-data");
        if (exifContainer) {
            exifContainer.style.display = "none";
        }
    },

    scheduleNextUpdate: function() {
        if (!this.running) return;

        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
        }

        this.updateTimer = setTimeout(() => {
            this.loadNextImage();
        }, this.config.updateInterval * 1000);
    },

    updateStatusIcon: function(navigationDirection = null) {
        if (!this.config.showStatusIcon) return;

        const statusIcon = document.getElementById("nextcloud-status-icon");
        if (!statusIcon) return;

        // Clear existing classes
        statusIcon.className = "";

        if (navigationDirection) {
            // Show navigation icon temporarily
            const iconClass = navigationDirection === "next" ? "fa-arrow-circle-right" : "fa-arrow-circle-left";
            statusIcon.className = `fas ${iconClass}`;
            
            // Show briefly then switch to play/pause
            setTimeout(() => {
                this.setPlayPauseIcon(statusIcon);
            }, 1500);
        } else {
            this.setPlayPauseIcon(statusIcon);
        }
    },

    setPlayPauseIcon: function(iconElement) {
        const iconClass = this.running ? "fa-play-circle" : "fa-pause-circle";
        iconElement.className = `fas ${iconClass}`;
        
        if (this.config.statusIconMode === "fade") {
            iconElement.style.opacity = "1";
            setTimeout(() => {
                iconElement.style.opacity = "0";
            }, 3000);
        } else {
            iconElement.style.opacity = "1";
        }
    },

    getDom: function() {
        const wrapper = document.createElement("div");
        wrapper.id = "nextcloud";
        wrapper.className = "nextcloud-container";

        // Set dimensions if not fullscreen
        if (!this.data.position || this.data.position.indexOf("fullscreen") === -1) {
            wrapper.style.position = "relative";
            wrapper.style.minWidth = "300px";
            wrapper.style.minHeight = "300px";
            
            if (this.config.showWidth) {
                wrapper.style.width = this.config.showWidth + "px";
            }
            if (this.config.showHeight) {
                wrapper.style.height = this.config.showHeight + "px";
            }
        }

        // Add blurred background image if blur is enabled
        if (this.config.blur) {
            const bgImg = document.createElement("img");
            bgImg.id = "nextcloud-background-blur";
            
            // Add appropriate class based on fullscreen mode
            const isFullscreen = this.data.position && this.data.position.indexOf("fullscreen") !== -1;
            bgImg.className = isFullscreen ? "nextcloud-background-blur nextcloud-fullscreen" : "nextcloud-background-blur";
            
            bgImg.style.opacity = "0"; // Initially hidden
            wrapper.appendChild(bgImg);
        }

        // Main image container
        const mainImg = document.createElement("img");
        mainImg.id = "nextcloud-main-image";
        
        // Add appropriate class based on fullscreen mode
        const isFullscreen = this.data.position && this.data.position.indexOf("fullscreen") !== -1;
        mainImg.className = isFullscreen ? "nextcloud-main-image nextcloud-fullscreen" : "nextcloud-main-image";
        
        mainImg.style.opacity = "0"; // Initially hidden
        wrapper.appendChild(mainImg);

        // EXIF data container
        if (this.config.showExifData) {
            const exifDiv = document.createElement("div");
            exifDiv.id = "nextcloud-exif-data";
            exifDiv.className = isFullscreen ? "nextcloud-exif-data nextcloud-fullscreen" : "nextcloud-exif-data";
            exifDiv.style.display = "none";
            wrapper.appendChild(exifDiv);
        }

        // Status icon
        if (this.config.showStatusIcon) {
            const statusContainer = document.createElement("div");
            statusContainer.id = "nextcloud-status-container";
            const statusClasses = `nextcloud-status-container nextcloud-status-${this.config.statusIconPosition.replace('_', '-')}`;
            statusContainer.className = isFullscreen ? `${statusClasses} nextcloud-fullscreen` : statusClasses;
            
            const statusIcon = document.createElement("i");
            statusIcon.id = "nextcloud-status-icon";
            statusIcon.className = "fas fa-pause-circle";
            statusIcon.style.opacity = "0";
            
            statusContainer.appendChild(statusIcon);
            wrapper.appendChild(statusContainer);
        }

        return wrapper;
    },

    getStyles: function() {
        return ["MMM-Nextcloud.css"];
    },

    notificationReceived: function(notification, payload, sender) {
        switch (notification) {
            case "MODULE_DOM_CREATED":
                if (this.config.startHidden) {
                    this.hide();
                } else if (this.imageList.length > 0) {
                    this.resumeImageLoading(true);
                }
                break;

            case "NEXTCLOUD_NEXT":
                if (this.updateTimer) clearTimeout(this.updateTimer);
                this.loadNextImage("next");
                if (this.config.showStatusIcon) {
                    this.updateStatusIcon("next");
                }
                break;

            case "NEXTCLOUD_PREVIOUS":
                if (!this.config.random && this.imageList.length > 0) {
                    if (this.updateTimer) clearTimeout(this.updateTimer);
                    this.loadNextImage("previous");
                    if (this.config.showStatusIcon) {
                        this.updateStatusIcon("previous");
                    }
                }
                break;

            case "NEXTCLOUD_TOGGLE":
                if (this.running) {
                    this.pauseImageLoading();
                } else {
                    this.resumeImageLoading(false);
                }
                break;

            case "NEXTCLOUD_PAUSE":
                this.pauseImageLoading();
                break;

            case "NEXTCLOUD_RESUME":
                this.resumeImageLoading(false);
                break;

            case "NEXTCLOUD_REFRESH_LIST":
                this.requestImageList();
                break;
        }
    },

    socketNotificationReceived: function(notification, payload) {
        switch (notification) {
            case "IMAGE_LIST_RECEIVED":
                Log.info(`[${this.name}] Received image list with ${payload.length} images`);
                this.imageList = payload;
                this.currentImageIndex = -1;
                
                if (!this.config.startHidden && this.imageList.length > 0) {
                    this.resumeImageLoading(true);
                }
                
                // Setup refresh timer for periodic list updates
                this.setupRefreshTimer();
                break;

            case "IMAGE_DATA_RECEIVED":
                Log.debug(`[${this.name}] Received image data`);
                this.displayImage(payload);
                break;

            case "ERROR":
                Log.error(`[${this.name}] Error from node helper: ${payload.message}`);
                this.showErrorMessage(payload.message);
                break;

            case "FETCH_PROGRESS":
                Log.debug(`[${this.name}] Fetch progress: ${payload.message}`);
                break;
        }
    },

    showErrorMessage: function(message) {
        const wrapper = document.getElementById("nextcloud");
        if (!wrapper) return;

        // Clear existing content
        wrapper.innerHTML = "";

        const errorDiv = document.createElement("div");
        errorDiv.className = "nextcloud-error";
        errorDiv.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: #ff6b6b;
            text-align: center;
            font-size: 1.2em;
            padding: 20px;
        `;
        errorDiv.textContent = `Error: ${message}`;

        wrapper.appendChild(errorDiv);
    },

    suspend: function() {
        Log.info(`[${this.name}] Module suspended`);
        this.pauseImageLoading();
        
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    },

    resume: function() {
        Log.info(`[${this.name}] Module resumed`);
        this.setupRefreshTimer();
        this.resumeImageLoading(true);
    }
});