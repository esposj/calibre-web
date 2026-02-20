/* global $, ePub, calibre */

(function () {
    "use strict";

    var defaults = {
        speed: 80,
        isPlaying: false,
        sidebarOpen: true,
        fontFamily: "Georgia, serif",
        fontSize: 110,
        lineHeight: 1.6,
        margin: 6,
        textWidth: 900,
        theme: "light",
        cfi: ""
    };

    var prefKey = "calibre.scrollbeta." + calibre.bookId;
    var prefs = loadPrefs();
    var book = ePub(calibre.bookUrl);
    var rendition = book.renderTo("beta-viewer", {
        width: "100%",
        height: "100%",
        manager: "continuous",
        flow: "scrolled-doc",
        spread: "none"
    });

    var currentLocation = null;
    var savedBookmark = calibre.bookmark || "";
    var rafId = 0;
    var lastTick = 0;
    var chapterLinks = [];

    var els = {
        body: document.body,
        sidebar: document.getElementById("beta-sidebar"),
        sidebarToggle: document.getElementById("beta-sidebar-toggle"),
        playToggle: document.getElementById("beta-play-toggle"),
        speed: document.getElementById("beta-speed"),
        speedLabel: document.getElementById("beta-speed-label"),
        speedDown: document.getElementById("beta-speed-down"),
        speedUp: document.getElementById("beta-speed-up"),
        prev: document.getElementById("beta-prev"),
        next: document.getElementById("beta-next"),
        chapterSelect: document.getElementById("beta-chapters"),
        toc: document.getElementById("beta-toc"),
        bookmarks: document.getElementById("beta-bookmarks"),
        bookmarkToggle: document.getElementById("beta-bookmark-toggle"),
        fontFamily: document.getElementById("beta-font-family"),
        fontSize: document.getElementById("beta-font-size"),
        fontSizeLabel: document.getElementById("beta-font-size-label"),
        lineHeight: document.getElementById("beta-line-height"),
        lineHeightLabel: document.getElementById("beta-line-height-label"),
        margin: document.getElementById("beta-margin"),
        marginLabel: document.getElementById("beta-margin-label"),
        textWidth: document.getElementById("beta-text-width"),
        textWidthLabel: document.getElementById("beta-text-width-label"),
        theme: document.getElementById("beta-theme"),
        title: document.getElementById("beta-title"),
        progress: document.getElementById("beta-progress"),
        pages: document.getElementById("beta-pages"),
        viewer: document.getElementById("beta-viewer")
    };

    initControls();
    applyPrefsToInputs();

    rendition.on("relocated", function (location) {
        currentLocation = location;
        persistLocation(location);
        updateProgress(location);
        updateBookmarkUi();
    });

    rendition.on("rendered", function (section) {
        if (section && section.href) {
            updateChapterSelection(section.href);
        }
        applyTheme();
        applyTypography();
    });

    book.ready.then(function () {
        return Promise.all([
            loadLocations(),
            book.loaded.navigation
        ]);
    }).then(function (results) {
        buildChapters(results[1]);
        updateProgress(currentLocation);
        renderBookmarkList();
        return safeDisplay(prefs.cfi || savedBookmark || undefined);
    }).catch(function () {
        return safeDisplay(undefined);
    });

    if (!calibre.useBookmarks) {
        els.bookmarkToggle.style.display = "none";
        els.bookmarks.innerHTML = "";
    }

    if (prefs.isPlaying) {
        startAutoScroll();
    } else {
        setPlayLabel(false);
    }

    function safeDisplay(target) {
        return rendition.display(target).catch(function () {
            return rendition.display();
        }).catch(function () {
            els.viewer.innerHTML = "<div style='padding:18px;color:#fff'>Failed to render book content.</div>";
        });
    }

    function loadPrefs() {
        try {
            var raw = localStorage.getItem(prefKey);
            if (!raw) {
                return Object.assign({}, defaults);
            }
            return Object.assign({}, defaults, JSON.parse(raw));
        } catch (err) {
            return Object.assign({}, defaults);
        }
    }

    function savePrefs() {
        try {
            localStorage.setItem(prefKey, JSON.stringify(prefs));
        } catch (err) {
            return;
        }
    }

    function initControls() {
        els.sidebarToggle.addEventListener("click", function () {
            prefs.sidebarOpen = !prefs.sidebarOpen;
            syncSidebar();
            savePrefs();
        });

        els.playToggle.addEventListener("click", toggleAutoScroll);
        els.speedDown.addEventListener("click", function () { updateSpeed(prefs.speed - 10); });
        els.speedUp.addEventListener("click", function () { updateSpeed(prefs.speed + 10); });
        els.speed.addEventListener("input", function () { updateSpeed(parseInt(els.speed.value, 10)); });

        els.prev.addEventListener("click", function () {
            pauseAutoScroll();
            rendition.prev();
        });
        els.next.addEventListener("click", function () {
            pauseAutoScroll();
            rendition.next();
        });

        els.chapterSelect.addEventListener("change", function () {
            if (els.chapterSelect.value) {
                pauseAutoScroll();
                rendition.display(els.chapterSelect.value);
            }
        });

        els.bookmarkToggle.addEventListener("click", function () {
            if (!currentLocation || !currentLocation.start || !currentLocation.start.cfi) {
                return;
            }
            if (savedBookmark) {
                savedBookmark = "";
                saveBookmark("");
            } else {
                savedBookmark = currentLocation.start.cfi;
                saveBookmark(savedBookmark);
            }
            renderBookmarkList();
            updateBookmarkUi();
        });

        els.fontFamily.addEventListener("change", function () {
            prefs.fontFamily = els.fontFamily.value;
            applyTypography();
        });
        els.fontSize.addEventListener("input", function () {
            prefs.fontSize = parseInt(els.fontSize.value, 10);
            applyTypography();
        });
        els.lineHeight.addEventListener("input", function () {
            prefs.lineHeight = parseFloat(els.lineHeight.value);
            applyTypography();
        });
        els.margin.addEventListener("input", function () {
            prefs.margin = parseInt(els.margin.value, 10);
            applyTypography();
        });
        els.textWidth.addEventListener("input", function () {
            prefs.textWidth = parseInt(els.textWidth.value, 10);
            applyTypography();
        });
        els.theme.addEventListener("change", function () {
            prefs.theme = els.theme.value;
            applyTheme();
            savePrefs();
        });

        document.addEventListener("keydown", function (event) {
            if (isTypingTarget(event.target)) {
                return;
            }
            if (event.code === "Space") {
                event.preventDefault();
                toggleAutoScroll();
                return;
            }
            if (event.code === "ArrowUp") {
                event.preventDefault();
                updateSpeed(prefs.speed + 10);
                return;
            }
            if (event.code === "ArrowDown") {
                event.preventDefault();
                updateSpeed(prefs.speed - 10);
                return;
            }
            if (event.code === "ArrowRight") {
                event.preventDefault();
                pauseAutoScroll();
                rendition.next();
                return;
            }
            if (event.code === "ArrowLeft") {
                event.preventDefault();
                pauseAutoScroll();
                rendition.prev();
            }
        });

        syncSidebar();
        updateSpeed(prefs.speed);
    }

    function applyPrefsToInputs() {
        els.speed.value = prefs.speed;
        els.fontFamily.value = prefs.fontFamily;
        els.fontSize.value = prefs.fontSize;
        els.lineHeight.value = prefs.lineHeight;
        els.margin.value = prefs.margin;
        els.textWidth.value = prefs.textWidth;
        els.theme.value = prefs.theme;
    }

    function syncSidebar() {
        if (prefs.sidebarOpen) {
            els.sidebar.classList.remove("closed");
        } else {
            els.sidebar.classList.add("closed");
        }
    }

    function updateSpeed(value) {
        var next = Math.max(20, Math.min(420, value));
        prefs.speed = next;
        els.speed.value = String(next);
        els.speedLabel.textContent = next + " px/s";
        savePrefs();
    }

    function toggleAutoScroll() {
        if (prefs.isPlaying) {
            pauseAutoScroll();
        } else {
            startAutoScroll();
        }
    }

    function startAutoScroll() {
        prefs.isPlaying = true;
        savePrefs();
        setPlayLabel(true);
        lastTick = 0;
        if (rafId) {
            cancelAnimationFrame(rafId);
        }
        rafId = requestAnimationFrame(stepAutoScroll);
    }

    function pauseAutoScroll() {
        prefs.isPlaying = false;
        savePrefs();
        setPlayLabel(false);
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
    }

    function setPlayLabel(isPlaying) {
        els.playToggle.textContent = isPlaying ? "Pause" : "Play";
    }

    function stepAutoScroll(timestamp) {
        if (!prefs.isPlaying) {
            return;
        }

        if (!lastTick) {
            lastTick = timestamp;
        }

        var seconds = (timestamp - lastTick) / 1000;
        lastTick = timestamp;
        var scrollEl = detectScrollElement();

        if (scrollEl) {
            var start = scrollEl.scrollTop;
            scrollEl.scrollTop = start + (prefs.speed * seconds);
            if (Math.abs(scrollEl.scrollTop - start) < 0.5) {
                rendition.next();
            }
        } else {
            rendition.next();
        }

        rafId = requestAnimationFrame(stepAutoScroll);
    }

    function detectScrollElement() {
        var candidates = [els.viewer];
        var extra = els.viewer.querySelectorAll(".epub-container, .epub-view, [style*='overflow']");
        var i;
        for (i = 0; i < extra.length; i += 1) {
            candidates.push(extra[i]);
        }

        for (i = 0; i < candidates.length; i += 1) {
            var node = candidates[i];
            if (!node) {
                continue;
            }
            var style = window.getComputedStyle(node);
            if ((style.overflowY === "auto" || style.overflowY === "scroll" || node === els.viewer) &&
                node.scrollHeight > node.clientHeight + 2) {
                return node;
            }
        }
        return null;
    }

    function persistLocation(location) {
        if (!location || !location.start || !location.start.cfi) {
            return;
        }
        prefs.cfi = location.start.cfi;
        savePrefs();
    }

    function loadLocations() {
        var key = book.key() + "-locations";
        var stored = localStorage.getItem(key);
        if (stored) {
            return Promise.resolve(book.locations.load(stored));
        }
        return book.locations.generate(1200).then(function () {
            localStorage.setItem(key, book.locations.save());
        });
    }

    function updateProgress(location) {
        if (!location || !location.start || typeof location.start.percentage !== "number") {
            return;
        }
        var pct = Math.round(location.start.percentage * 100);
        els.progress.textContent = pct + "%";
        var loc = book.locations.locationFromCfi(location.start.cfi);
        var total = book.locations.length();
        if (typeof loc === "number" && total) {
            els.pages.textContent = (loc + 1) + "/" + total;
        }

        if (location.start.displayed && location.start.displayed.chapter) {
            els.title.textContent = location.start.displayed.chapter;
        }
    }

    function buildChapters(navigation) {
        if (!navigation || !navigation.toc) {
            return;
        }

        chapterLinks = [];
        var flat = [];

        function flatten(items, depth) {
            items.forEach(function (item) {
                flat.push({
                    label: item.label || item.href,
                    href: item.href,
                    depth: depth
                });
                chapterLinks.push(item.href);
                if (item.subitems && item.subitems.length) {
                    flatten(item.subitems, depth + 1);
                }
            });
        }

        flatten(navigation.toc, 0);
        els.toc.innerHTML = "";
        els.chapterSelect.innerHTML = "";

        flat.forEach(function (item) {
            var li = document.createElement("li");
            var button = document.createElement("button");
            button.type = "button";
            button.textContent = new Array(item.depth + 1).join("  ") + item.label;
            button.addEventListener("click", function () {
                pauseAutoScroll();
                rendition.display(item.href);
            });
            li.appendChild(button);
            els.toc.appendChild(li);

            var option = document.createElement("option");
            option.value = item.href;
            option.textContent = new Array(item.depth + 1).join("- ") + item.label;
            els.chapterSelect.appendChild(option);
        });
    }

    function updateChapterSelection(href) {
        var i;
        if (!href) {
            return;
        }
        for (i = 0; i < els.chapterSelect.options.length; i += 1) {
            if (els.chapterSelect.options[i].value === href) {
                els.chapterSelect.selectedIndex = i;
                return;
            }
        }
    }

    function renderBookmarkList() {
        els.bookmarks.innerHTML = "";
        if (!savedBookmark) {
            var empty = document.createElement("li");
            empty.textContent = "No bookmark";
            els.bookmarks.appendChild(empty);
            return;
        }

        var li = document.createElement("li");
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = "Go to bookmark";
        button.addEventListener("click", function () {
            pauseAutoScroll();
            rendition.display(savedBookmark);
        });
        li.appendChild(button);
        els.bookmarks.appendChild(li);
    }

    function updateBookmarkUi() {
        if (!currentLocation || !currentLocation.start || !currentLocation.start.cfi) {
            return;
        }
        var isCurrent = savedBookmark && savedBookmark === currentLocation.start.cfi;
        els.bookmarkToggle.textContent = isCurrent ? "Clear Bookmark" : "Bookmark";
    }

    function saveBookmark(cfi) {
        var csrftoken = $("input[name='csrf_token']").val();
        $.ajax(calibre.bookmarkUrl, {
            method: "post",
            data: { bookmark: cfi || "" },
            headers: { "X-CSRFToken": csrftoken }
        });
    }

    function applyTheme() {
        els.body.classList.remove("theme-light", "theme-sepia", "theme-dark");
        els.body.classList.add("theme-" + prefs.theme);

        var palette = {
            light: { bg: "#ffffff", fg: "#111111" },
            sepia: { bg: "#fbf1dc", fg: "#3c2d1e" },
            dark: { bg: "#111111", fg: "#dddddd" }
        };

        var pick = palette[prefs.theme] || palette.light;
        rendition.themes.register("beta-theme", {
            body: {
                "background-color": pick.bg + " !important",
                color: pick.fg + " !important"
            },
            p: {
                color: pick.fg + " !important"
            }
        });
        rendition.themes.select("beta-theme");
    }

    function applyTypography() {
        els.fontSizeLabel.textContent = prefs.fontSize + "%";
        els.lineHeightLabel.textContent = prefs.lineHeight.toFixed(1);
        els.marginLabel.textContent = prefs.margin + "%";
        els.textWidthLabel.textContent = prefs.textWidth + "px";

        rendition.themes.fontSize(prefs.fontSize + "%");
        rendition.themes.override("font-family", prefs.fontFamily);
        rendition.themes.override("line-height", String(prefs.lineHeight));
        rendition.themes.override("margin-left", prefs.margin + "%");
        rendition.themes.override("margin-right", prefs.margin + "%");
        rendition.themes.override("max-width", prefs.textWidth + "px");
        rendition.themes.override("margin-inline", "auto");
        savePrefs();
    }

    function isTypingTarget(target) {
        if (!target) {
            return false;
        }
        var tag = target.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
    }
})();
