/* global PDFViewerApplication */
import { Model, View, App, Session, Data, Messenger, Constants } from "@croquet/croquet";

import apiKey from "./apiKey.js";

const Q = Constants;
Q.MAX_FILE_MB = 50;
Q.PLACE_TIMEOUT = 1000;

class PDFModel extends Model {
    init(_options, persisted) {
        super.init();

        this.resetPlaceParameters();

        this.subscribe('load', 'request', this.requestLoad);
        this.subscribe('load', 'start', this.startLoad);

        this.subscribe('place', 'set', this.setPlace);
        this.subscribe('place', 'endInteraction', this.endInteraction);
        this.interactionStatus = {};

        this.subscribe('rotation', 'request', this.requestRotation);
        this.subscribe('scrollMode', 'request', this.requestScrollMode);

        this.subscribe(this.sessionId, 'view-exit', this.onViewExit);

        this.knownHandles = {}; // from source hash to data handle
        this.docSourceHash = null; // the currently open document

        if (persisted) this.restoreFromPersisted(persisted);

        this._VERSION_BUMP = 2;
    }

    getPersistedData() {
        const persistableHandles = {};
        for (const [sourceHash, { handle, name }] of Object.entries(this.knownHandles)) {
            persistableHandles[sourceHash] = { id: Data.toId(handle), name };
        }
        return {
            handles: persistableHandles,
            docSourceHash: this.docSourceHash
            };
    }

    restoreFromPersisted({ handles, docSourceHash }) {
        this.knownHandles = {};
        for (const [sourceHash, { id, name }] of Object.entries(handles)) {
            this.knownHandles[sourceHash] = { handle: Data.fromId(id), name };
        }
        if (docSourceHash) {
            const { handle, name } = this.knownHandles[docSourceHash];
            const loadSpec = {
                sourceHash: docSourceHash,
                viewId: this.viewId,
                handle,
                name,
                userDescription: "recovered session",
                };
            this.startLoad(loadSpec);
        }
    }

    resetPlaceParameters() {
        this.scroll = { top: 0, left: 0 };
        this.relativeScale = 1;
        this.pagesRotation = 0;
        this.scrollMode = 0;
    }

    requestLoad(data) {
        const { viewId, sourceHash } = data;
        if (!this.applyLockIfAvailable({ viewId, sourceHash, lock: "load" })) return;

        this.publish('load', 'approved', data);
    }

    startLoad(data) {
        const { viewId, sourceHash, handle, name, userDescription } = data;
        if (!this.knownHandles[sourceHash]) this.knownHandles[sourceHash] = { handle, name };

        // in general, the load:start event follows a load:request.
        // but if a file is being uploaded, there can be many seconds
        // between the two; another client can send a load:request
        // that supersedes the previous one.  in that case, a load:start
        // with a sourceHash different from the latest load:request should
        // be rejected.
        // but if the file doesn't need uploading (it's already known to
        // the session), there will be no load:request - and a userDescription
        // will have been added to the load:start.  such an event is allowed
        // to override the load that was expected.
        if (!userDescription && sourceHash !== this.interactionStatus.sourceHash) {
            console.log(`PDFModel: ignoring superseded load of ${name}`);
            return;
        }

        this.interactionStatus = {};
        this.resetPlaceParameters();
        this.docSourceHash = sourceHash;
        this.persistSession(this.getPersistedData); // pass the function
        this.publish('load', 'ready', { viewId, sourceHash, name, userDescription });
    }

    setPlace(data) {
        const { viewId } = data;
        if (!this.applyLockIfAvailable({ viewId, lock: "place" })) return;

        this.applyPlace(data);
    }

    applyPlace(data) {
        const { viewId, page, top, left, scale, rotation, scrollMode } = data;
        this.scroll = { page, top, left };
        this.relativeScale = scale;
        this.pagesRotation = rotation;
        this.scrollMode = scrollMode;
        // console.log(`model applyPlace: ${viewId}, ${top}, ${left}, scale ${scale}`);
        this.publish('place', 'update', viewId);
    }

    endInteraction(viewId) {
        // the view is ending a mouse-down interaction, which may or may not
        // have been for scrolling.
        if (this.interactionStatus && this.interactionStatus.viewId === viewId) this.releaseInteractionStatus();
    }

    requestRotation(data) {
        const { viewId } = data;
        if (this.applyLockIfAvailable({ viewId, lock: "place" })) this.publish('rotation', 'approved', data);
    }

    requestScrollMode(data) {
        const { viewId } = data;
        if (this.applyLockIfAvailable({ viewId, lock: "place" })) this.publish('scrollMode', 'approved', data);
    }

    applyLockIfAvailable(data) {
        const { viewId: newViewId, lock: newLock } = data;
        const { viewId, lock } = this.interactionStatus;
        switch (newLock) {
            case "place":
                // "place" can only be applied if no view had the initiative,
                // or if the same view already held "place".
                if (viewId && (viewId !== newViewId || lock !== "place")) return false;

                // a "place" lock expires if not refreshed for some time
                this.future(Q.PLACE_TIMEOUT).checkInteractionStatus();
                break;
            case "load":
                // "load" is only rejected if some view is already registered
                // as uploading exactly the same file.
                if (lock === "load" && this.interactionStatus.sourceHash === data.sourceHash) return false;

                // it does not expire until the pending load completes or is replaced.
                break;
            default:
        }

        this.interactionStatus = { ...data, time: this.now() };
        return true;
    }

    checkInteractionStatus() {
        const { lock, time } = this.interactionStatus;
        const now = this.now();
        if (lock === "place" && now - time === Q.PLACE_TIMEOUT) this.releaseInteractionStatus();
    }

    releaseInteractionStatus() {
        // console.log(`releasing lock for ${this.interactionStatus.viewId}`);
        this.interactionStatus = {};
    }

    onViewExit(viewId) {
        // if a user disappears, make sure they didn't exit holding a lock
        if (this.interactionStatus.viewId === viewId) {
            this.releaseInteractionStatus();
        }
    }
}
PDFModel.register("PDFModel");


class PDFView extends View {
    constructor(model) {
        super(model);
        this.model = model;

        this.isInIframe = window !== window.top;
        this.container = PDFViewerApplication.pdfViewer.container;
        this.subscribe('place', { event: 'update', handling: 'oncePerFrame' }, this.onUpdatePlace); // from Model

        this.listenerManager = new ListenerManager();
        this.listenerManager.addListener({
            element: this.container,
            type: 'scroll',
            listener: this.onScroll,
            thisArg: this,
            });
        this.listenerManager.addListener({
            element: document,
            type: 'mousedown',
            listener: this.docMouseDown,
            options: true,
            thisArg: this,
            });
        this.listenerManager.addListener({
            element: document,
            type: 'mouseup',
            listener: this.docMouseUp,
            options: true,
            thisArg: this,
           });

        this.defaultUserDescription = `view ${this.viewId.slice(0, 2)}`;
        if (this.isInIframe) this.userDescription = null;
        else this.acceptDefaultUserDescription();

        this.eventBusListeners = [];

        // * = Croquet-added events
        this.addEventBusListener('viewerdrivenscroll', this.onViewerDrivenScroll); // *
        this.addEventBusListener('beforescalechange', this.onBeforeScaleChange); // *

        this.addEventBusListener('requestrotation', this.onRequestRotation); // *
        this.addEventBusListener('beforerotationchange', this.onBeforeRotationChange); // *
        this.subscribe('rotation', 'approved', this.onRotationApproved);

        this.addEventBusListener('requestscrollmode', this.onRequestScrollMode); // *
        this.addEventBusListener('beforescrollmodechange', this.onBeforeScrollModeChange); // *
        this.subscribe('scrollMode', 'approved', this.onScrollModeApproved);

        this.addEventBusListener('fileinputchange', this.onFileInputChange);
        this.subscribe('load', 'approved', this.onLoadApproved);
        this.subscribe('load', 'ready', this.onLoadReady);

        this.addEventBusListener('documentinit', this.onDocumentInit);

        if (window.parent !== window) {
            // assume (cavalierly) that we're embedded in Q
            Messenger.startPublishingPointerMove();

            Messenger.setReceiver(this);
            Messenger.on("uploadFile", "handleUploadFile");
            Messenger.send("appReady", window.location.href);
            Messenger.on("userCursor", "handleUserCursor");
            Messenger.send("userCursorRequest");
            Messenger.on("userInfo", "handleUserInfo");
            Messenger.send("userInfoRequest");
            Messenger.on("appInfoRequest", () => {
                Messenger.send("appInfo", { appName: "docview", label: "document", iconName: "pdf.svgIcon", urlTemplate: "../docview/?q=${q}" });
                });
        }

        this.docSourceHash = null;
        this.activeUploader = null;
        this.trackingMouseDrag = false;
        this._dontPublishViewScroll = false;
        this.resetPlaceParameters();
        if (model.docSourceHash) this.loadFromSourceHash(model.docSourceHash);
    }

    addEventBusListener(event, listener) {
        listener = listener.bind(this);
        this.eventBusListeners.push({ event, listener });
        PDFViewerApplication.eventBus.on(event, listener);
    }
    removeEventBusListeners() {
        this.eventBusListeners.forEach(_ => {
            const { event, listener } = _;
            PDFViewerApplication.eventBus.off(event, listener);
        });
    }

    handleUserCursor(data) {
        window.document.body.style.setProperty("cursor", data);
    }

    handleUserInfo(data) {
        const { initials } = data;
        if (initials) this.userDescription = `user ${initials}`;
        else this.acceptDefaultUserDescription();
    }

    handleUploadFile(data) {
        this.uploadFile(data.file);
    }

    resetPlaceParameters() {
        this.localScale = 1; // scale for rendering.  depends on shared scale and browser width.
        this.viewRelativeScale = "1.0";
        this.viewRotation = 0;
        this.viewScrollMode = 0;
        this.lastPublishedPlace = null;
    }

    requestUserInfo() {
        if (this.userDescription !== null) return; // the details have come through

        window.parent.postMessage("askLandingPageInfo", "*");
        this.future(1000).requestUserInfo(); // set up another try, in case the parent isn't ready yet
    }

    acceptDefaultUserDescription() {
        this.userDescription = this.defaultUserDescription;
    }

    getUserDescription() {
        return this.userDescription || this.defaultUserDescription;
    }

    closeDocument() {
        // console.log("close document");

        // @@ probably need to do more to ensure events related to
        // old document are ignored
        // App.showSyncWait(true);
        this.clearThrottledInvoke('publishPlace'); // from previous document
        this.docSourceHash = null;
        this.resetPlaceParameters();

        // @@ any need to handle the returned promise that signals when
        // destruction is complete?
        PDFViewerApplication.close();
    }

    prepareForDocument(sourceHash) {
        this.docSourceHash = sourceHash;
    }

    onDocumentInit() {
        // console.log("document init");
        const sourceHash = this.docSourceHash;
        const { name } = this.model.knownHandles[sourceHash];
        PDFViewerApplication.setTitle(name);
        this.syncPlaceWithModel();
        // App.showSyncWait(false);
    }

    docMouseDown(event) {
        // while the mouse is down, whether engaged in scrolling or not,
        // this view will suppress scroll events from other views.
        // if this view obtains the scrolling initiative and keeps sending
        // scroll events, the model will hold back all other views' scroll
        // events anyway.  if this view sends no scroll event for 1000ms,
        // the model will send any deferred scroll received from another
        // view, and put the initiative up for grabs by the first view to
        // send more scroll events (which could be this one again).

        // very ad-hoc decision on whether the mouse-down counts.  this
        // will probably work for the scroll bar, and for the main text
        // area iff using the hand tool.
        const target = event.target;
        if (target !== document.getElementById('viewerContainer') &&
            !target.classList.contains('textLayer')) return;

        // if there is an outstanding timer from a non-mouse-down scroll,
        // cancel it.
        if (this.suppressionTimer) {
            clearTimeout(this.suppressionTimer);
            delete this.suppressionTimer;
        }

        this.trackingMouseDrag = this.userIsActive = true;
        this.syncPlaceOnRelease = false; // unless we hear from a remote client
    }
    docMouseUp(event) {
        if (!this.trackingMouseDrag) return;

        this.trackingMouseDrag = false;
        // tell the model immediately that this view has finished its
        // interaction.  the model will only act if this view had been
        // granted the scrolling initiative.
        this.publish('scroll', 'endInteraction', this.viewId);
        this.releaseUserActive();
    }
    releaseUserActive() {
        this.userIsActive = false;
        this.showClashWarning(false);
        if (this.syncPlaceOnRelease) this.syncPlaceWithModel();
        delete this.syncPlaceOnRelease;
    }

    onScroll(event) {
        // the view has been scrolled, either by view manipulation (a scroll or
        // pan) or on request from here - either to sync to the model, or in
        // response to a trapped viewer-driven scroll arising from some other
        // setting (e.g., a change of scale or rotation).
        // in the former case, we need to publish the new scroll setting; in the
        // latter, we must not.
        // because of the asynchronous generation of DOM events, there is no guarantee
        // that the first event handled here after scroll has been set explicitly will
        // correspond to that update; it could be that a user-generated event has
        // slipped in afterwards and shifted the DOM element again.
        // we therefore keep a record of the scroll position that was set.  if the
        // element's position now is the same as that, we assume that this is just
        // informing us of that setting.  if not, we publish the scroll as a new
        // user-driven event.

        const { scrollTop, scrollLeft } = this.container;
        if (this.lastForcedScroll) {
            const { top: lastTop, left: lastLeft, time } = this.lastForcedScroll;
            this.lastForcedScroll = null;
            const FORCED_SCROLL_TIMEOUT = 1000; // if older than this, ignore it
            const timeSince = Date.now() - time;
            if (timeSince <= FORCED_SCROLL_TIMEOUT) {
                if (scrollTop === lastTop && scrollLeft === lastLeft) return; // the one we were waiting for

                console.log("mismatch with forced scroll", { scrollTop, scrollLeft }, { lastTop, lastLeft });
            }
        }

        if (!this.trackingMouseDrag) this.setOrExtendBusyState();

        this.schedulePublishPlace();
    }

    setOrExtendBusyState() {
        // if the mouse is not down, we have no direct way of knowing when the user
        // has finished a placement interaction.  suppress remote place events
        // for 500ms following each move.
        if (!this.userIsActive) {
            this.userIsActive = true;
            this.syncPlaceOnRelease = false;
        }

        if (this.suppressionTimer) clearTimeout(this.suppressionTimer);
        this.suppressionTimer = setTimeout(() => {
            delete this.suppressionTimer;
            this.releaseUserActive();
        }, 500);
    }

    schedulePublishPlace() {
        this.throttledInvoke('publishPlace', 33, () => this.publishPlaceIfNew());
    }
    publishPlaceIfNew() {
        // ready to publish.  perform a last-minute check that
        // the model is still apparently free of a lock that would
        // block this event.
        if (!this.okToPublish('place')) {
            this.showClashWarning(true);
            return;
        }

        // if the rounded pixel value of the local scroll position
        // at unity render scale has changed by no more than 1,
        // don't publish.  if it has changed, publish at 10000x
        // to add precision on all clients' scaling calculations.
        const { scrollTop, scrollLeft } = this.container;
        const firstVisiblePage = PDFViewerApplication.pdfViewer._getVisiblePages().first;
        if (!firstVisiblePage) return;

        const page = firstVisiblePage.id; // page number, starting with 1
        const { top: pageTop, left: pageLeft } = firstVisiblePage.view._croquetTopLeft;
        const topInPage = scrollTop - pageTop;
        const leftInPage = scrollLeft - pageLeft;
        const topUnity = topInPage <= 0 ? topInPage : Math.round(topInPage / this.localScale);
        const leftUnity = leftInPage <= 0 ? leftInPage : Math.round(leftInPage / this.localScale);

        const lastPlace = this.lastPublishedPlace;
        if (lastPlace &&
            page === lastPlace.page &&
            Math.abs(topUnity - lastPlace.top) < 2 &&
            Math.abs(leftUnity - lastPlace.left) < 2 &&
            this.viewRelativeScale === lastPlace.scale &&
            this.viewRotation === lastPlace.rotation &&
            this.viewScrollMode === lastPlace.scrollMode
        ) return;

        const placeParameters = { scale: this.viewRelativeScale, rotation: this.viewRotation, scrollMode: this.viewScrollMode }; // all but the scroll
        this.lastPublishedPlace = { page, top: topUnity, left: leftUnity, ...placeParameters };

        const top10k = topInPage <= 0 ? topInPage : Math.round(topInPage * 10000 / this.localScale);
        const left10k = leftInPage <= 0 ? leftInPage : Math.round(leftInPage * 10000 / this.localScale);
        this.publish('place', 'set', { viewId: this.viewId, page, top: top10k, left: left10k, ...placeParameters });
    }

    onViewerDrivenScroll(data) {
        // any scroll caused by issuing a command to the pdfViewer -
        // whether by user interaction (page, zoom, find, resize), or
        // by this app applying a model-driven update such as change of
        // scale - will result in a viewerdrivenscroll event that arrives here.
        // data is { element, top, left } - though left, at least, is in
        // theory optional.
        // the demanded scroll position will not necessarily be achievable.
        // for example, if a document that is zoomed and scrolled so that the
        // view is centred near the right of a page is then zoomed out,
        // the browser can refuse to scroll the narrowed document far enough
        // to the left to keep that point centred.  same for a document
        // scrolled all the way to the bottom, then zoomed out.
        const { top, left, publish } = data;
        const hasTop = top !== undefined;
        const hasLeft = left !== undefined;
        if (hasTop && hasLeft) this.container.scrollTo({ top, left });
        else if (hasTop) this.container.scrollTop = top;
        else this.container.scrollLeft = left;

        // pick up what the browser actually did with the scroll request
        const { scrollTop, scrollLeft } = this.container;
        this.lastForcedScroll = { top: scrollTop, left: scrollLeft, time: Date.now() };

        // our hacked pdf viewer sends the viewerdrivenscroll event, rather than
        // directly moving the view, to increase our control over scrolling.
        // viewer scrolls that are simply readjustments of the document's position
        // in response to some local change - of window size, say - should not
        // trigger publication to update the model.  in these cases, the event's
        // "publish" property will be false.
        // but when the scroll is in response to a change in the relative scale,
        // which therefore needs publishing, the viewer sets "publish" to true.
        // likewise, "publish" is true on scroll events caused by the viewer
        // resetting its page view - for example, when the user hits the
        // "next page" button - because this is the only event the Croquet app
        // is going to receive.
        if (publish && !this._dontPublishViewScroll) {
            // console.warn(`vds: publish = ${publish}`);
            this.setOrExtendBusyState();
            this.schedulePublishPlace();
        }
    }

    syncPlaceWithModel() {
        this._dontPublishViewScroll = true;
        PDFViewerApplication.pdfViewer.scrollModeApproved(this.model.scrollMode);
        PDFViewerApplication.pdfViewer.pagesRotationApproved(this.model.pagesRotation);
        // this will synchronously invoke onBeforeScaleChange, setting
        // localScale and viewRelativeScale.
        PDFViewerApplication.pdfViewer.currentScale = this.model.relativeScale;
        this._dontPublishViewScroll = false;

        const { page, top: top10k, left: left10k } = this.model.scroll;
        const pageView = PDFViewerApplication.pdfViewer.getPageView(page - 1);
        if (!pageView) return;

        const { top: pageTop, left: pageLeft } = pageView._croquetTopLeft;
        const top = pageTop + (top10k <= 0 ? top10k : Math.round(top10k * this.localScale / 10000));
        const left = pageLeft + (left10k <= 0 ? left10k : Math.round(left10k * this.localScale / 10000));
        this.container.scrollTo({ top, left });

        // find out and record where the container actually scrolled to
        const { scrollTop, scrollLeft } = this.container;
        this.lastForcedScroll = { top: scrollTop, left: scrollLeft, time: Date.now() };
    }

    onUpdatePlace(viewId) {
        // a "place" event forwarded from the model.

        if (this.viewId === viewId) {
            // if our own event comes through, the model has given this
            // view the lock.  clear any clash warning.
            this.showClashWarning(false);
            this.syncPlaceOnRelease = false;

            return; // but ignore the event
        }

        // it's another view's event.  clear our own anti-duplication record.
        this.lastPublishedPlace = null;

        // but if we're busy, ignore the event.
        if (this.userIsActive) {
            this.showClashWarning(true);
            this.syncPlaceOnRelease = true;
            return;
        }

        this.syncPlaceWithModel();
    }

    // SCALE
    onBeforeScaleChange(event) {
        // beforescalechange event from the viewer
        const { scale, presetValue: relativeScale } = event;
        // console.warn(`recording local scale ${scale}, relative ${relativeScale}`);
        this.localScale = scale;
        this.viewRelativeScale = relativeScale;
    }

    okToPublish(eventName) {
        // check whether the model appears to be in a state that
        // would allow this client to publish the specified event.
        // because we don't know what other messages are on their
        // way to the model, this is at best a guess.  we err on
        // the side of caution (not attempting a send if it looks
        // like the event will be rejected), but even if the coast
        // seems to be clear now, something might intervene.
        // because the model will block events from clients that
        // don't hold (and can't obtain) the necessary lock, there
        // is no guarantee that an event published from here will
        // come back to us.
        const { lock, viewId } = this.model.interactionStatus || {};
        if (!lock) return true; // no lock?  no problem.

        const isOurs = viewId === this.viewId;
        switch (eventName) {
            case "place":
                // ok if we hold the lock, unless it's a "load"
                return isOurs && lock !== "load";
            case "hash":
                // can override any client's "place" lock,
                // but not someone else's "load"
                return !(lock === "load" && !isOurs);
            default:
                return true; // shouldn't happen.  good luck.
        }
    }

    showClashWarning(bool) {
        const element = document.getElementById('viewerContainer');
        if (bool) element.classList.add('interactionClash');
        else element.classList.remove('interactionClash');
    }

    throttledInvoke(key, time, fn) {
        // timeout of -1 means run immediately
        if (time === -1) {
            fn();
            return;
        }

        // NB: for a given key, the function that will be invoked by
        // the timeout is the most recent one supplied to this method.

        // NB: always use a timeout (even if zero), in case the
        // requesting code is relying on completing other computations
        // before the throttled invocation happens.

        if (!this.throttles) this.throttles = {};

        let spec = this.throttles[key];
        if (!spec) spec = this.throttles[key] = {};

        spec.fn = fn;

        if (spec.timeout) return;

        let now = Date.now();
        let timeRemaining = spec.lastInvoke ? spec.lastInvoke + time - now : 0;
        /* synchronous invocation disabled; see comment above
        if (timeRemaining <= 0) {
            spec.lastInvoke = now;
            fn();
            return;
        }
        */

        spec.timeout = setTimeout(() => {
            delete spec.timeout;
            spec.lastInvoke = Date.now();
            spec.fn();
        }, Math.max(0, timeRemaining));
    }

    clearThrottledInvoke(key) {
        if (!this.throttles) return;

        let spec = this.throttles[key];
        if (spec && spec.timeout) clearTimeout(spec.timeout);
        delete this.throttles[key];
    }

    // ROTATION
    onRequestRotation(event) {
        // request from viewer
        this.setOrExtendBusyState(); // just so we highlight any clash
        const { rotation } = event;
        const { viewId } = this;
        this.publish('rotation', 'request', { viewId, rotation });
    }
    onRotationApproved({ viewId, rotation }) {
        // approved request from model
        if (this.viewId === viewId) PDFViewerApplication.pdfViewer.pagesRotationApproved(rotation);
    }
    onBeforeRotationChange(event) {
        // beforerotationchange event from the viewer
        const { rotation } = event;
        // console.warn(`recording rotation ${rotation}`);
        this.viewRotation = rotation;
    }

    // SCROLL MODE
    onRequestScrollMode(event) {
        // request from viewer
        this.setOrExtendBusyState(); // just so we highlight any clash
        const { mode } = event;
        const { viewId } = this;
        this.publish('scrollMode', 'request', { viewId, mode });
    }
    onScrollModeApproved({ viewId, mode }) {
        // approved request from model
        if (this.viewId === viewId) PDFViewerApplication.pdfViewer.scrollModeApproved(mode);
    }
    onBeforeScrollModeChange(event) {
        // beforescrollmodechange event from the viewer
        const { mode } = event;
        this.viewScrollMode = mode;
    }

    // FILE INPUT
    onFileInputChange(event) {
        const { files } = event.fileInput;
        const file = files[0];
        if (file) this.uploadFile(file);
    }

    async uploadFile(file) {
        this.activeUploader = null;

        // file is either an OS file object or a POJO with
        // properties { name, size, type, croquet_contents }
        if (file.size === 0) {
            showToastWarning(`${file.name} has zero length`);
            return;
        }

        if (file.size > Q.MAX_FILE_MB * 1048576) {
            showToastWarning(`${file.name} exceeds max size of ${Q.MAX_FILE_MB}MB`);
            return;
        }

        if (!(await isFileDisplayable(file))) {
            showToastWarning(`${file.name} is not of a known convertible type`);
            return;
        }

        const uploader = new FileUploader(file, this.sessionId);
        let sourceHash;
        try {
            sourceHash = await uploader.getSourceHash(); // hash of the source bytes
        } catch (err) {
            showToastWarning(`${file.name} - ${err.message}`);
            return;
        }

        if (sourceHash === this.docSourceHash) {
            showToastWarning(`document is already loaded`);
            return;
        }

        this.activeUploader = uploader;

        const { viewId } = this;
        const userDescription = this.getUserDescription();

        // if the dropped file is one for which the model already has
        // a known handle, we can skip straight to the load:start event.
        // in this case, add userDescription.  remote views will display
        // a suitable message.
        const existing = this.model.knownHandles[sourceHash];
        if (existing) {
            const { handle, name } = existing;
            this.publish('load', 'start', { sourceHash, viewId, handle, name, userDescription });
            return;
        }

        // otherwise, ask the model to tell
        // everyone that this view is uploading the file.
        // the model will agree, sending load:approved, unless
        // another view is already uploading exactly the same file.
        const name = uploader.getFileName();
        this.publish('load', 'request', { sourceHash, viewId, name, userDescription });
    }

    async onLoadApproved(data) {
        this.trackingMouseDrag = false; // in case we were tracking
        this.closeDocument();

        const { viewId, sourceHash, name, userDescription } = data;
        if (viewId === this.viewId) {
            const { activeUploader } = this;
            if (!activeUploader) {
                console.warn("uploader not found"); // a glitch in the matrix
                return;
            }

            // if the file isn't already a pdf, the uploader will run a
            // conversion first, which could take many seconds.
            // in that time, another view might have stolen the initiative.
            // even so, publish the handle so the same document can be
            // uploaded instantly in the future.
            const handle = await activeUploader.getPDFHandle();
            if (handle) this.publish('load', 'start', { viewId, sourceHash, handle, name });
        } else {
            showToastLog(`${userDescription} is uploading ${name}`);
        }
    }

    async onLoadReady(data) {
        const { viewId, sourceHash, name, userDescription } = data;

        // userDescription will be defined iff the user dropped
        // a file already known to this session (so there was no
        // "uploading" stage).
        if (userDescription && viewId !== this.viewId) {
            showToastLog(`${userDescription} dropped ${name}`);
        }

        // this view will have an active uploader if a file was
        // recently dropped in.  the model has now decided which
        // file everyone is going to load; if that's not the file
        // that was dropped here, silently discard the uploader.
        const { activeUploader } = this;
        this.activeUploader = null;
        if (activeUploader) {
            const expected = await activeUploader.getSourceHash();
            // if the dropped file was already a pdf, save time by using
            // the uploader's buffer directly instead of fetching
            // the derived url.
            if (expected === sourceHash && !activeUploader.needsConversion) {
                this.prepareForDocument(sourceHash);
                const buffer = await activeUploader.getSourceBuffer();
                PDFViewerApplication.open(buffer);
                return;
            }
        }

        this.loadFromSourceHash(sourceHash, /* suppressName = */ true);
    }

    async loadFromSourceHash(sourceHash, suppressName=false) {
        this.prepareForDocument(sourceHash);

        const { handle, name } = this.model.knownHandles[sourceHash];
        showToastLog(`reading${suppressName ? "..." : " " + name}`);
        const buffer = await Data.fetch(this.sessionId, handle);
        PDFViewerApplication.open(buffer);
    }

    update() {
        this.sendScrollTestingEvents(); // TEST
    }

    detach() {
        // @@ probably lots more pdf-viewer cleanup we should be doing
        this.listenerManager.detach();
        this.removeEventBusListeners();
        super.detach();
    }

    // TEST ONLY
    sendScrollTestingEvents() {
        if (!window.testScroll) return;

        const now = Date.now();
        if (!this.lastTestScroll) {
            this.lastTestScroll = now;
        }
        if (!this.scheduledTest) {
            this.scheduledTest = true;
            setTimeout(() => { this.runningTest = true; this.testBase = (10 + Math.random() * 8) * 1000; }, 5000);
            setTimeout(() => { this.runningTest = this.scheduledTest = false; }, 10000);
        }
        if (this.runningTest && now - this.lastTestScroll > 50) {
            const { scrollLeft } = this.container;
            const top = Math.round(this.testBase + 500 * Math.sin(now * Math.PI / 5000));
            this.container.scrollTo({ top, left: scrollLeft });
            this.lastTestScroll = now;
        }
    }
}

class FileUploader {
    constructor(file, sessionId) {
        // file is either an OS file object or a POJO with
        // properties { name, size, type, croquet_contents }
        this.file = file;
        this.sessionId = sessionId;
        this.needsConversion = file.type !== 'application/pdf';
    }

    fromBase64url(base64) {
        return new Uint8Array(atob(base64.padEnd((base64.length + 3) & ~3, "=")
            .replace(/-/g, "+")
            .replace(/_/g, "/")).split('').map(c => c.charCodeAt(0)));
    }

    toBase64url(bits) {
        return btoa(String.fromCharCode(...new Uint8Array(bits)))
            .replace(/=/g, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_");
    }

    getFileName() {
        return this.file.name;
    }

    getSourceBuffer() {
        // returns a Promise
        if (this.sourceBufferP) return this.sourceBufferP;

        const file = this.file;
        let promise;
        if (file.croquet_contents) {
            promise = Promise.resolve(file.croquet_contents);
        } else if (file.arrayBuffer) {
            // File.arrayBuffer() is sparsely supported
            promise = file.arrayBuffer();
        } else {
            promise = new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.readAsArrayBuffer(file);
            });
        }

        this.sourceBufferP = promise;
        return promise;
    }

    // the sourceHash is the hash of the content of a dropped file -
    // before conversion, uploading, etc.  used to check whether we've
    // already seen the same file in this session.
    async getSourceHash() {
        if (!this.sourceHash) this.sourceHash = await this.hashSourceBuffer();

        return this.sourceHash;
    }

    async hashSourceBuffer() {
        const buffer = await this.getSourceBuffer();
        // MS Edge does not like empty buffer
        if (buffer.length === 0) return "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";
        const bits = await window.crypto.subtle.digest("SHA-256", buffer);
        return this.toBase64url(bits);
    }

    async getPDFHandle() {
        if (this.pdfHandle !== undefined) return this.pdfHandle;

        this.pdfHandle = null; // this signifies that we have at least tried
        let pdfBuffer;
        if (this.needsConversion) {
            showToastLog(`requesting conversion...`);
            const conversionUrl = 'https://croquet.io/convert/pdf';
            const formData = new FormData();
            const receivedFile = this.file;
            let postableFile;
            if (!receivedFile.croquet_contents) postableFile = receivedFile;
            else {
                postableFile = new File([receivedFile.croquet_contents], receivedFile.name, { type: receivedFile.type });
            }
            formData.append('file', postableFile);
            pdfBuffer = await fetch(conversionUrl, {
                method: 'POST',
                mode: 'same-origin',
                referrer: App.referrerURL(),
                body: formData
            }).then(response => {
                if (response.ok) {
                    showToastLog(`...conversion complete`);
                    return response.arrayBuffer();
                }
                return response.json().then(jsonStatus => {
                    const { statusCode, message } = jsonStatus;
                    throw Error(`error ${statusCode}: ${message}`);
                    });
            }).catch(err => {
                showToastError(`conversion: ${err.message}`);
                return null;
            });

            if (pdfBuffer === null) return null;
        } else pdfBuffer = await this.getSourceBuffer();

        showToastLog(`uploading ${this.needsConversion ? "conversion result" : "PDF"}...`);
        this.pdfHandle = await Data.store(this.sessionId, pdfBuffer, /* keep = */ true); // don't transfer the buffer to the worker
        showToastLog(`...upload complete`);
        return this.pdfHandle;
    }
}

class ListenerManager {
    constructor() {
        this.eventListeners = [];
    }

    addEventListener(element, type, listener, options, thisArg = this) {
        listener = listener.bind(thisArg);
        this.eventListeners.push({ element, type, listener });

        element.addEventListener(type, listener, options);
    }
    addListener({ element, type, listener, options, thisArg }) {
        this.addEventListener(element, type, listener, options, thisArg);
    }

    removeListeners() {
        this.eventListeners.forEach(({ element, type, listener }) => {
            element.removeEventListener(type, listener);
        });
    }

    detach() {
        this.removeListeners();
    }
}

let fileFormatsP;
const setUpFileFormats = () => {
    const url = "https://croquet.io/convert/formats";
    fileFormatsP = new Promise(resolve => {
        fetch(url, {
            method: "GET",
            mode: "cors",
            headers: { "Content-Type": "text" }
        }).then(response => {
            return response.ok ? response.json() : null;
        }).then(json => {
            if (json) {
                // the json is split into values under "document",
                // "graphics", "presentation", "spreadsheet".
                // there is overlap between these categories, and
                // several types that are listed under multiple
                // file formats.  so gather them with a Set.
                // similarly for extensions.
                const types = new Set();
                const extensions = new Set();
                Object.values(json).forEach(formats => {
                    formats.forEach(format => {
                        types.add(format.mime);
                        extensions.add(format.extension);
                    });
                });
                // feb 2021: EPS conversion doesn't work, for unknown
                // reasons (would need to check the converter deployment)
                types.delete("application/postscript");
                extensions.delete("eps");
                resolve({ types: Array.from(types), extensions: Array.from(extensions) });
            } else {
                console.warn("failed to load conversion formats");
                resolve({ types: [], extensions: [] });
            }
        }).catch(e => {
            console.error(e.message, e);
            resolve({ types: [], extensions: [] });
        });
    });
    };
setUpFileFormats();

const isFileDisplayable = async file => {
    const { name, type } = file;
    // we assume any texty file can be converted
    if (type.startsWith('text/')) return true;

    // otherwise, check the file's extension against our converter's list
    const extn = name.slice((name.lastIndexOf(".") - 1 >>> 0) + 2);
    const extensions = (await fileFormatsP).extensions;
    return !!(extn && extensions.includes(extn));
    };

const startSession = () => {
    App.root = 'outerContainer';
    // App.sync = false;
    App.messages = true;
    App.showMessage = (msg, options = {}) => {
        if (!options.pdfCustom) return;

        App.messageFunction(msg, options);
        };

    const joinArgs = {
        appId: 'io.croquet.docview',
        name: App.autoSession(),
        apiKey,
        password: 'dummy-pass',
        model: PDFModel,
        view: PDFView,
        tps: 4 // need ticks to handle future messages for lock timeout
        };
    Session.join(joinArgs);
    };

const showToast = (msg, level, duration) => App.showMessage(msg, { pdfCustom: true, level, duration });
const showToastLog = msg => showToast(msg);
const showToastWarning = msg => showToast(msg, "warning", 3000);
const showToastError = msg => showToast(msg, "error", 3000);

// immediately quash file drops, otherwise browser will jump to a
// local file view if drop happens before viewer is ready.
document.addEventListener("dragover", evt => evt.preventDefault());
document.addEventListener("drop", evt => evt.preventDefault());

// see https://github.com/mozilla/pdf.js/wiki/Third-party-viewer-usage
document.addEventListener('webviewerloaded', _event => {
    window.PDFViewerApplication.initializedPromise.then(startSession);
});
