(function() {
  'use strict';

  /**
   * SF Analytics Tracker - Enhanced Version
   * Features:
   * - Event queuing with automatic retry
   * - Batch sending to reduce requests
   * - Offline support with localStorage fallback
   * - Rate limiting protection
   * - Better error handling and debugging
   * - Extensible event system
   * - Session replay preparation
   */

  class SFTracker {
    constructor(config = {}) {
      this.config = {
        username: config.username || '',
        businessId: config.businessId || '',
        origin: config.origin ? config.origin.replace(/\/$/, '') : '',
        variant: config.variant || 'A',
        conversionValue: config.conversionValue || 0,
        debug: config.debug || false,
        batchSize: config.batchSize || 10,
        batchInterval: config.batchInterval || 5000, // 5 seconds
        maxQueueSize: config.maxQueueSize || 100,
        maxRetries: config.maxRetries || 3,
        retryDelay: config.retryDelay || 2000,
        enableOfflineQueue: config.enableOfflineQueue !== false,
        enableHeatmap: config.enableHeatmap !== false,
        enableSessionReplay: config.enableSessionReplay || false,
        samplingRate: config.samplingRate || 1.0 // 1.0 = 100% of sessions tracked
      };

      // Validate required config
      if (!this.config.username || !this.config.businessId || !this.config.origin) {
        this.log('error', 'Missing required configuration', {
          username: !!this.config.username,
          businessId: !!this.config.businessId,
          origin: !!this.config.origin
        });
        return;
      }

      // Apply sampling - decide if this session should be tracked
      if (Math.random() > this.config.samplingRate) {
        this.log('info', 'Session not sampled, tracking disabled');
        this.disabled = true;
        return;
      }

      // State management
      this.queue = [];
      this.sending = false;
      this.batchTimer = null;
      this.startTime = Date.now();
      this.maxScroll = 0;
      this.sessionData = {
        events: [],
        interactions: 0,
        scrollDepth: 0,
        timeOnPage: 0
      };

      // Flags for one-time events
      this.flags = {
        scroll50: false,
        scroll100: false,
        engaged30s: false,
        engaged60s: false
      };

      // Initialize IDs
      this.initializeIds();
      
      // Load offline queue
      this.loadOfflineQueue();
      
      // Set up event listeners
      this.setupListeners();
      
      // Start batch processing
      this.startBatchTimer();
      
      // Send initial view event
      this.trackView();
      
      // Engagement tracking
      this.setupEngagementTracking();

      this.log('info', 'Tracker initialized', { businessId: this.config.businessId });
    }

    log(level, message, data = {}) {
      if (this.config.debug || level === 'error') {
        console[level === 'error' ? 'error' : 'log'](`[SF-Tracker] ${message}`, data);
      }
    }

    initializeIds() {
      // User ID (persistent across sessions)
      if (!localStorage.getItem('sf_uid')) {
        localStorage.setItem('sf_uid', this.generateId());
      }
      this.uid = localStorage.getItem('sf_uid');

      // Session ID (new per session)
      if (!sessionStorage.getItem('sf_sid')) {
        sessionStorage.setItem('sf_sid', this.generateId());
        sessionStorage.setItem('sf_sid_start', Date.now().toString());
      }
      this.sid = sessionStorage.getItem('sf_sid');
    }

    generateId() {
      // Fallback for browsers without crypto.randomUUID
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }

    getDeviceInfo() {
      const ua = navigator.userAgent;
      
      const device = (() => {
        if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) return 'tablet';
        if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/i.test(ua)) return 'mobile';
        return 'desktop';
      })();

      const browser = (() => {
        if (ua.includes('Edg')) return 'Edge';
        if (ua.includes('Chrome')) return 'Chrome';
        if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
        if (ua.includes('Firefox')) return 'Firefox';
        return 'Other';
      })();

      const os = (() => {
        if (ua.includes('Windows')) return 'Windows';
        if (ua.includes('Mac OS')) return 'macOS';
        if (ua.includes('Android')) return 'Android';
        if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
        if (ua.includes('Linux')) return 'Linux';
        return 'Other';
      })();

      return {
        browser,
        os,
        device,
        screen: {
          width: window.screen.width,
          height: window.screen.height,
          availWidth: window.screen.availWidth,
          availHeight: window.screen.availHeight
        },
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      };
    }

    getPageInfo() {
      const referrer = document.referrer || 'direct';
      
      const refType = (() => {
        if (!referrer || referrer === 'direct') return 'direct';
        if (referrer.includes('google')) return 'search';
        if (referrer.includes('facebook') || referrer.includes('t.co') || 
            referrer.includes('instagram') || referrer.includes('linkedin')) return 'social';
        // Check if referrer is same domain
        try {
          const refUrl = new URL(referrer);
          if (refUrl.hostname === window.location.hostname) return 'internal';
        } catch (e) {
          // Invalid URL
        }
        return 'referral';
      })();

      return {
        path: window.location.pathname,
        url: window.location.href,
        title: document.title,
        referrer,
        refType,
        queryParams: Object.fromEntries(new URLSearchParams(window.location.search))
      };
    }

    createEvent(type, extra = {}) {
      return {
        type,
        timestamp: Date.now(),
        username: this.config.username,
        businessId: this.config.businessId,
        sid: this.sid,
        uid: this.uid,
        variant: this.config.variant,
        page: this.getPageInfo(),
        device: this.getDeviceInfo(),
        session: {
          duration: Date.now() - this.startTime,
          events: this.sessionData.events.length,
          interactions: this.sessionData.interactions,
          scrollDepth: this.maxScroll
        },
        ...extra
      };
    }

    enqueue(event) {
      if (this.disabled) return;

      // Add to session data
      this.sessionData.events.push({
        type: event.type,
        timestamp: event.timestamp
      });

      // Check queue size limit
      if (this.queue.length >= this.config.maxQueueSize) {
        this.log('warn', 'Queue full, dropping oldest event');
        this.queue.shift();
      }

      this.queue.push(event);
      this.log('debug', 'Event queued', { type: event.type, queueSize: this.queue.length });

      // Save to offline queue if enabled
      if (this.config.enableOfflineQueue) {
        this.saveOfflineQueue();
      }

      // Send immediately if queue is at batch size
      if (this.queue.length >= this.config.batchSize) {
        this.sendBatch();
      }
    }

    startBatchTimer() {
      if (this.batchTimer) {
        clearInterval(this.batchTimer);
      }

      this.batchTimer = setInterval(() => {
        if (this.queue.length > 0) {
          this.sendBatch();
        }
      }, this.config.batchInterval);
    }

    async sendBatch(retryCount = 0) {
      if (this.disabled || this.sending || this.queue.length === 0) return;

      this.sending = true;
      const batch = this.queue.splice(0, this.config.batchSize);
      
      try {
        const url = `${this.config.origin}/api/analytics/batch`;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: batch }),
          keepalive: true,
          mode: 'cors'
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        this.log('debug', 'Batch sent successfully', { count: batch.length });
        
        // Clear offline queue on success
        if (this.config.enableOfflineQueue) {
          this.clearOfflineQueue();
        }

      } catch (error) {
        this.log('error', 'Batch send failed', { error: error.message, retryCount });

        // Retry logic
        if (retryCount < this.config.maxRetries) {
          // Put events back in queue
          this.queue.unshift(...batch);
          
          setTimeout(() => {
            this.sendBatch(retryCount + 1);
          }, this.config.retryDelay * Math.pow(2, retryCount)); // Exponential backoff
        } else {
          this.log('error', 'Max retries reached, events dropped', { count: batch.length });
        }
      } finally {
        this.sending = false;
      }
    }

    sendBeacon(event) {
      // Use sendBeacon for critical exit events
      if (!navigator.sendBeacon) {
        return this.enqueue(event);
      }

      try {
        const url = `${this.config.origin}/api/analytics/track`;
        const blob = new Blob([JSON.stringify(event)], { type: 'application/json' });
        const success = navigator.sendBeacon(url, blob);
        
        if (!success) {
          this.enqueue(event);
        }
      } catch (error) {
        this.enqueue(event);
      }
    }

    saveOfflineQueue() {
      try {
        const data = {
          queue: this.queue,
          timestamp: Date.now()
        };
        localStorage.setItem('sf_offline_queue', JSON.stringify(data));
      } catch (error) {
        this.log('error', 'Failed to save offline queue', { error: error.message });
      }
    }

    loadOfflineQueue() {
      try {
        const data = localStorage.getItem('sf_offline_queue');
        if (data) {
          const parsed = JSON.parse(data);
          
          // Only load if less than 24 hours old
          if (Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) {
            this.queue = parsed.queue || [];
            this.log('info', 'Loaded offline queue', { count: this.queue.length });
          } else {
            this.clearOfflineQueue();
          }
        }
      } catch (error) {
        this.log('error', 'Failed to load offline queue', { error: error.message });
        this.clearOfflineQueue();
      }
    }

    clearOfflineQueue() {
      try {
        localStorage.removeItem('sf_offline_queue');
      } catch (error) {
        this.log('error', 'Failed to clear offline queue', { error: error.message });
      }
    }

    setupListeners() {
      // Scroll tracking
      let scrollTimeout;
      window.addEventListener('scroll', () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          const scrollPercent = Math.round(
            (window.scrollY + window.innerHeight) / document.documentElement.scrollHeight * 100
          );
          
          if (scrollPercent > this.maxScroll) {
            this.maxScroll = scrollPercent;
            this.sessionData.scrollDepth = scrollPercent;

            if (scrollPercent >= 50 && !this.flags.scroll50) {
              this.flags.scroll50 = true;
              this.track('funnel_step', { step: 'scroll_50', depth: scrollPercent });
            }
            if (scrollPercent >= 100 && !this.flags.scroll100) {
              this.flags.scroll100 = true;
              this.track('funnel_step', { step: 'scroll_100', depth: scrollPercent });
            }
          }
        }, 100);
      }, { passive: true });

      // Click tracking
      document.addEventListener('click', (e) => {
        this.sessionData.interactions++;

        // Heatmap
        if (this.config.enableHeatmap) {
          this.track('heatmap', {
            x: e.clientX,
            y: e.clientY,
            scrollY: window.scrollY,
            path: this.getElementPath(e.target)
          });
        }

        const target = e.target.closest('a, button, input[type="submit"], input[type="button"], [role="button"]');
        if (target) {
          const text = (target.innerText || target.value || '').toLowerCase().trim();
          const isGoal = this.isGoalElement(target, text);
          
          this.track('interaction', {
            type: 'click',
            tag: target.tagName,
            id: target.id || null,
            classes: target.className || null,
            text: text.substring(0, 100),
            href: target.href || null,
            isGoal
          });

          if (isGoal) {
            this.track('conversion', {
              value: this.config.conversionValue,
              label: text.substring(0, 50) || target.id || 'unknown',
              element: {
                tag: target.tagName,
                id: target.id,
                text: text.substring(0, 100)
              }
            });
          }
        }
      }, { passive: true });

      // Form tracking
      document.addEventListener('submit', (e) => {
        const form = e.target;
        const formData = new FormData(form);
        const fields = {};
        
        // Capture field types (not values for privacy)
        for (let [key, value] of formData.entries()) {
          const input = form.elements[key];
          fields[key] = {
            type: input ? input.type : 'unknown',
            hasValue: !!value
          };
        }

        this.track('form_submit', {
          formId: form.id || null,
          formAction: form.action || null,
          fieldCount: Object.keys(fields).length,
          fields
        });
      }, { passive: true });

      // Input focus tracking (for form analytics)
      document.addEventListener('focusin', (e) => {
        if (e.target.matches('input, textarea, select')) {
          this.track('form_field_focus', {
            fieldId: e.target.id || null,
            fieldName: e.target.name || null,
            fieldType: e.target.type || null,
            formId: e.target.form?.id || null
          });
        }
      }, { passive: true });

      // Visibility change
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.handleExit();
        }
      });

      // Before unload
      window.addEventListener('beforeunload', () => {
        this.handleExit();
      });

      // Page load performance
      if (window.performance && window.performance.timing) {
        window.addEventListener('load', () => {
          setTimeout(() => {
            this.trackPerformance();
          }, 0);
        });
      }

      // Error tracking
      window.addEventListener('error', (e) => {
        this.track('error', {
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno
        });
      });

      // Resource timing (for detailed performance analysis)
      if ('PerformanceObserver' in window) {
        try {
          const perfObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.entryType === 'navigation') {
                this.track('navigation_timing', {
                  dns: entry.domainLookupEnd - entry.domainLookupStart,
                  tcp: entry.connectEnd - entry.connectStart,
                  ttfb: entry.responseStart - entry.requestStart,
                  download: entry.responseEnd - entry.responseStart,
                  domInteractive: entry.domInteractive,
                  domComplete: entry.domComplete,
                  loadComplete: entry.loadEventEnd
                });
              }
            }
          });
          perfObserver.observe({ entryTypes: ['navigation'] });
        } catch (e) {
          this.log('warn', 'PerformanceObserver not supported');
        }
      }
    }

    setupEngagementTracking() {
      // 30 second engagement
      setTimeout(() => {
        if (!this.flags.engaged30s) {
          this.flags.engaged30s = true;
          this.track('engagement', { 
            duration: 30,
            interactions: this.sessionData.interactions,
            scrollDepth: this.maxScroll
          });
        }
      }, 30000);

      // 60 second engagement
      setTimeout(() => {
        if (!this.flags.engaged60s) {
          this.flags.engaged60s = true;
          this.track('engagement', { 
            duration: 60,
            interactions: this.sessionData.interactions,
            scrollDepth: this.maxScroll
          });
        }
      }, 60000);
    }

    getElementPath(element) {
      const path = [];
      let current = element;
      
      while (current && current !== document.body && path.length < 5) {
        let selector = current.tagName.toLowerCase();
        if (current.id) {
          selector += `#${current.id}`;
        } else if (current.className) {
          selector += `.${current.className.split(' ').join('.')}`;
        }
        path.unshift(selector);
        current = current.parentElement;
      }
      
      return path.join(' > ');
    }

    isGoalElement(element, text) {
      const goalKeywords = [
        'contact', 'book', 'get started', 'buy', 'purchase',
        'quote', 'submit', 'sign up', 'subscribe', 'download',
        'register', 'join', 'try', 'demo', 'free trial'
      ];

      const textMatch = goalKeywords.some(keyword => text.includes(keyword));
      const idMatch = element.id && goalKeywords.some(keyword => 
        element.id.toLowerCase().includes(keyword) || element.id.toLowerCase().includes('cta')
      );
      const classMatch = element.className && (
        element.className.toLowerCase().includes('cta') ||
        goalKeywords.some(keyword => element.className.toLowerCase().includes(keyword))
      );

      return textMatch || idMatch || classMatch;
    }

    handleExit() {
      const timeOnPage = Math.round((Date.now() - this.startTime) / 1000);
      this.sessionData.timeOnPage = timeOnPage;

      const exitEvent = this.createEvent('exit', {
        time: timeOnPage,
        maxScroll: this.maxScroll,
        interactions: this.sessionData.interactions,
        sessionSummary: this.sessionData
      });

      // Use sendBeacon for exit to ensure it's sent
      this.sendBeacon(exitEvent);

      // Try to send any remaining queued events
      if (this.queue.length > 0) {
        this.sendBatch();
      }
    }

    trackPerformance() {
      if (!window.performance || !window.performance.timing) return;

      const timing = window.performance.timing;
      const loadTime = timing.loadEventEnd - timing.navigationStart;
      
      if (loadTime > 0) {
        this.track('perf', {
          loadTime,
          domReady: timing.domContentLoadedEventEnd - timing.navigationStart,
          firstByte: timing.responseStart - timing.navigationStart,
          domParse: timing.domComplete - timing.domLoading
        });
      }

      // Core Web Vitals with web-vitals library
      if (typeof WebVitals !== 'undefined') {
        this.trackWebVitals();
      } else {
        // Try to load web-vitals dynamically
        import('https://unpkg.com/web-vitals@3/dist/web-vitals.js')
          .then(() => this.trackWebVitals())
          .catch(() => this.log('warn', 'Could not load web-vitals'));
      }
    }

    trackWebVitals() {
      if (typeof webVitals === 'undefined') return;

      const vitals = ['LCP', 'CLS', 'FID', 'INP', 'FCP', 'TTFB'];
      
      vitals.forEach(vital => {
        const handler = webVitals[`on${vital}`];
        if (handler) {
          handler((metric) => {
            this.track('vital', {
              name: metric.name,
              value: metric.value,
              rating: metric.rating,
              delta: metric.delta
            });
          });
        }
      });
    }

    // Public API methods
    track(type, data = {}) {
      const event = this.createEvent(type, data);
      this.enqueue(event);
    }

    trackView() {
      this.track('view', { step: 'view' });
    }

    trackCustomEvent(eventName, properties = {}) {
      this.track('custom', {
        eventName,
        properties
      });
    }

    identify(userId, traits = {}) {
      // Update user ID and track identification
      if (userId) {
        localStorage.setItem('sf_identified_uid', userId);
        this.track('identify', {
          userId,
          traits,
          anonymousId: this.uid
        });
      }
    }

    setUserProperties(properties = {}) {
      this.track('user_properties', { properties });
    }

    destroy() {
      if (this.batchTimer) {
        clearInterval(this.batchTimer);
      }
      
      // Send any remaining events
      if (this.queue.length > 0) {
        this.sendBatch();
      }
    }
  }

  // Initialize tracker with global config
  const config = window._sf_config || {};
  window._sf_tracker = new SFTracker(config);

  // Expose public API
  window.sfAnalytics = {
    track: (event, data) => window._sf_tracker.track(event, data),
    trackCustomEvent: (name, props) => window._sf_tracker.trackCustomEvent(name, props),
    identify: (userId, traits) => window._sf_tracker.identify(userId, traits),
    setUserProperties: (props) => window._sf_tracker.setUserProperties(props)
  };

})();
