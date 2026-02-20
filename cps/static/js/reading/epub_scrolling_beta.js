/* global $, calibre, EPUBJS, ePubReader, themes */

var reader;

(function () {
    "use strict";

    var storagePrefix = "calibre.scrollingReader.";
    var state = {
        isPlaying: false,
        speed: 70,
        fontSize: 100,
        fontFamily: "default",
        lineSpacing: 1.5,
        sideMargin: 40,
        textWidth: 820,
        theme: "lightTheme"
    };
    var chapterItems = [];
    var activeChapterIndex = -1;
    var intervalId = null;
    var lastTickMs = 0;
    var chapterAdvanceCooldownUntil = 0;
    var pendingPositionPersist = null;
    var lastPersistedCfi = null;

    var $progress = $("#progress");
    var $pages = $("#pages-count");
    var $speed = $("#scroll-speed");
    var $speedValue = $("#speed-value");
    var $playPause = $("#scroll-play-pause");
    var $chapterSelect = $("#chapter-select");
    var playLabel = $playPause.data("playLabel") || "Play";
    var pauseLabel = $playPause.data("pauseLabel") || "Pause";
    var emptyChapterLabel = $chapterSelect.data("emptyLabel") || "No chapters";
    var $fontFamily = $("#beta-font-family");
    var $fontSizeDisplay = $("#font-size-display");
    var $lineSpacing = $("#beta-line-spacing");
    var $lineSpacingValue = $("#beta-line-spacing-value");
    var $sideMargin = $("#beta-side-margin");
    var $sideMarginValue = $("#beta-side-margin-value");
    var $textWidth = $("#beta-text-width");
    var $textWidthValue = $("#beta-text-width-value");

    function getStoredNumber(key, fallback) {
        var value = localStorage.getItem(storagePrefix + key);
        if (value === null || value === "") {
            return fallback;
        }
        var parsed = Number(value);
        return isNaN(parsed) ? fallback : parsed;
    }

    function getStoredString(key, fallback) {
        var value = localStorage.getItem(storagePrefix + key);
        return value || fallback;
    }

    function getStoredBool(key, fallback) {
        var value = localStorage.getItem(storagePrefix + key);
        if (value === null) {
            return fallback;
        }
        return value === "true";
    }

    function persistState() {
        localStorage.setItem(storagePrefix + "isPlaying", String(state.isPlaying));
        localStorage.setItem(storagePrefix + "speed", String(state.speed));
        localStorage.setItem(storagePrefix + "fontSize", String(state.fontSize));
        localStorage.setItem(storagePrefix + "fontFamily", state.fontFamily);
        localStorage.setItem(storagePrefix + "lineSpacing", String(state.lineSpacing));
        localStorage.setItem(storagePrefix + "sideMargin", String(state.sideMargin));
        localStorage.setItem(storagePrefix + "textWidth", String(state.textWidth));
        localStorage.setItem(storagePrefix + "theme", state.theme);
    }

    function loadState() {
        state.isPlaying = getStoredBool("isPlaying", false);
        state.speed = getStoredNumber("speed", 70);
        state.fontSize = getStoredNumber("fontSize", 100);
        state.fontFamily = getStoredString("fontFamily", "default");
        state.lineSpacing = getStoredNumber("lineSpacing", 1.5);
        state.sideMargin = getStoredNumber("sideMargin", 40);
        state.textWidth = getStoredNumber("textWidth", 820);
        state.theme = getStoredString("theme", "lightTheme");
    }

    function updateControlsFromState() {
        $speed.val(state.speed);
        $speedValue.text(state.speed + " px/s");
        $fontSizeDisplay.text(state.fontSize + "%");
        $fontFamily.val(state.fontFamily);
        $lineSpacing.val(state.lineSpacing);
        $lineSpacingValue.text(String(state.lineSpacing));
        $sideMargin.val(state.sideMargin);
        $sideMarginValue.text(state.sideMargin + "px");
        $textWidth.val(state.textWidth);
        $textWidthValue.text(state.textWidth + "px");
        $playPause.text(state.isPlaying ? pauseLabel : playLabel);
    }

    function schedulePositionPersist(positionKey, location) {
        if (!location || !location.start || !location.start.cfi) {
            return;
        }
        var cfi = location.start.cfi;
        if (cfi === lastPersistedCfi) {
            return;
        }
        if (pendingPositionPersist) {
            clearTimeout(pendingPositionPersist);
            pendingPositionPersist = null;
        }
        pendingPositionPersist = setTimeout(function () {
            try {
                localStorage.setItem(positionKey, JSON.stringify({
                    cfi: cfi,
                    percentage: location.start.percentage
                }));
                lastPersistedCfi = cfi;
            } catch (e) {}
            pendingPositionPersist = null;
        }, 300);
    }

    function currentThemeTextColor() {
        return themes[state.theme] && themes[state.theme]["title-color"] ? themes[state.theme]["title-color"] : "#4f4f4f";
    }

    function applyTheme(themeName) {
        if (!themes[themeName]) {
            themeName = "lightTheme";
        }
        state.theme = themeName;
        try {
            reader.rendition.themes.select(themeName);
        } catch (e) {}
        $("#main").css("backgroundColor", themes[themeName].bgColor);
        $("#titlebar, #progress, #pages-count, #speed-value").css("color", currentThemeTextColor());
        persistState();
    }

    function applyTypographyToRendition() {
        if (!reader || !reader.rendition || !reader.rendition.themes) {
            return;
        }
        try {
            reader.rendition.themes.fontSize(state.fontSize + "%");
            if (state.fontFamily === "default") {
                reader.rendition.themes.font("serif");
            } else {
                reader.rendition.themes.font(state.fontFamily);
            }
            reader.rendition.themes.override("line-height", String(state.lineSpacing));
            reader.rendition.themes.override("margin-left", state.sideMargin + "px");
            reader.rendition.themes.override("margin-right", state.sideMargin + "px");
            reader.rendition.themes.override("max-width", state.textWidth + "px");
            reader.rendition.themes.override("margin-top", "20px");
            reader.rendition.themes.override("margin-bottom", "20px");
        } catch (e) {}
    }

    function updateBookmark(action, location) {
        if (action === "add") {
            this.settings.bookmarks
                .filter(function (bookmark) {
                    return bookmark && bookmark !== location;
                })
                .forEach(function (bookmark) {
                    this.removeBookmark(bookmark);
                }.bind(this));
        }
        $.ajax(calibre.bookmarkUrl, {
            method: "post",
            data: { bookmark: location || "" },
            headers: { "X-CSRFToken": $("input[name='csrf_token']").val() }
        });
    }

    function flattenToc(items, acc) {
        if (!items || !items.length) {
            return acc;
        }
        items.forEach(function (item) {
            if (item && item.href) {
                acc.push({ label: item.label || item.href, href: item.href });
            }
            flattenToc(item && (item.subitems || item.children), acc);
        });
        return acc;
    }

    function updateActiveChapterByHref(href) {
        if (!href || !chapterItems.length) {
            return;
        }
        var cleaned = href.split("#")[0];
        var matchedIndex = -1;
        for (var i = 0; i < chapterItems.length; i++) {
            var chapterHref = chapterItems[i].href.split("#")[0];
            if (cleaned === chapterHref || cleaned.indexOf(chapterHref) === 0) {
                matchedIndex = i;
                break;
            }
        }
        if (matchedIndex > -1) {
            activeChapterIndex = matchedIndex;
            $chapterSelect.val(String(matchedIndex));
        }
    }

    function jumpToChapter(index) {
        if (index < 0 || index >= chapterItems.length) {
            return;
        }
        activeChapterIndex = index;
        reader.rendition.display(chapterItems[index].href);
    }

    function scrollCurrentContents(deltaPx) {
        if (!reader || !reader.rendition || !reader.rendition.getContents) {
            return false;
        }
        var contents = reader.rendition.getContents();
        for (var i = 0; i < contents.length; i++) {
            var content = contents[i];
            if (!content || !content.document || !content.window) {
                continue;
            }
            var doc = content.document;
            var win = content.window;
            var root = doc.scrollingElement || doc.documentElement || doc.body;
            if (!root) {
                continue;
            }
            var maxScrollTop = root.scrollHeight - win.innerHeight;
            if (maxScrollTop <= 0) {
                continue;
            }
            var currentTop = root.scrollTop || 0;
            if (currentTop < maxScrollTop - 1) {
                root.scrollTop = Math.min(maxScrollTop, currentTop + deltaPx);
                return true;
            }
        }
        return false;
    }

    function tick() {
        var now = Date.now();
        if (!lastTickMs) {
            lastTickMs = now;
        }
        var dt = (now - lastTickMs) / 1000;
        if (dt <= 0) {
            dt = 0.04;
        }
        if (dt > 0.25) {
            dt = 0.25;
        }
        lastTickMs = now;

        if (state.isPlaying) {
            var moved = scrollCurrentContents(state.speed * dt);
            if (!moved && now >= chapterAdvanceCooldownUntil) {
                chapterAdvanceCooldownUntil = now + 1200;
                try {
                    reader.rendition.next();
                } catch (e) {}
            }
        }
    }

    function startTicker() {
        if (!intervalId) {
            intervalId = window.setInterval(tick, 40);
        }
    }

    function bindControls() {
        $("#scroll-play-pause").on("click", function () {
            state.isPlaying = !state.isPlaying;
            $playPause.text(state.isPlaying ? pauseLabel : playLabel);
            persistState();
        });
        $("#speed-faster").on("click", function () {
            state.speed = Math.min(320, Number(state.speed) + 10);
            updateControlsFromState();
            persistState();
        });
        $("#speed-slower").on("click", function () {
            state.speed = Math.max(20, Number(state.speed) - 10);
            updateControlsFromState();
            persistState();
        });
        $speed.on("input change", function () {
            state.speed = Number($(this).val());
            $speedValue.text(state.speed + " px/s");
            persistState();
        });
        $("#chapter-prev").on("click", function () {
            if (!chapterItems.length) {
                return;
            }
            jumpToChapter(Math.max(0, activeChapterIndex - 1));
        });
        $("#chapter-next").on("click", function () {
            if (!chapterItems.length) {
                return;
            }
            jumpToChapter(Math.min(chapterItems.length - 1, activeChapterIndex + 1));
        });
        $chapterSelect.on("change", function () {
            var index = Number($(this).val());
            if (!isNaN(index)) {
                jumpToChapter(index);
            }
        });
        $("#font-size-increase").on("click", function () {
            state.fontSize = Math.min(300, Number(state.fontSize) + 5);
            updateControlsFromState();
            applyTypographyToRendition();
            persistState();
        });
        $("#font-size-decrease").on("click", function () {
            state.fontSize = Math.max(50, Number(state.fontSize) - 5);
            updateControlsFromState();
            applyTypographyToRendition();
            persistState();
        });
        $fontFamily.on("change", function () {
            state.fontFamily = $(this).val();
            applyTypographyToRendition();
            persistState();
        });
        $lineSpacing.on("input change", function () {
            state.lineSpacing = Number($(this).val());
            $lineSpacingValue.text(String(state.lineSpacing));
            applyTypographyToRendition();
            persistState();
        });
        $sideMargin.on("input change", function () {
            state.sideMargin = Number($(this).val());
            $sideMarginValue.text(state.sideMargin + "px");
            applyTypographyToRendition();
            persistState();
        });
        $textWidth.on("input change", function () {
            state.textWidth = Number($(this).val());
            $textWidthValue.text(state.textWidth + "px");
            applyTypographyToRendition();
            persistState();
        });
        $("#beta-themes button").on("click", function () {
            applyTheme($(this).data("theme"));
        });
        $(document).on("keydown", function (event) {
            if ($(event.target).is("input, select, textarea, [contenteditable='true']")) {
                return;
            }
            if (event.code === "Space") {
                event.preventDefault();
                state.isPlaying = !state.isPlaying;
                $playPause.text(state.isPlaying ? pauseLabel : playLabel);
                persistState();
                return;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                state.speed = Math.max(20, Number(state.speed) - 10);
                updateControlsFromState();
                persistState();
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                state.speed = Math.min(320, Number(state.speed) + 10);
                updateControlsFromState();
                persistState();
                return;
            }
            if (event.key === "[") {
                event.preventDefault();
                jumpToChapter(Math.max(0, activeChapterIndex - 1));
                return;
            }
            if (event.key === "]") {
                event.preventDefault();
                jumpToChapter(Math.min(chapterItems.length - 1, activeChapterIndex + 1));
            }
        });
    }

    function initializeReader() {
        EPUBJS.filePath = calibre.filePath;
        EPUBJS.cssPath = calibre.cssPath;

        reader = ePubReader(calibre.bookUrl, {
            restore: true,
            bookmarks: calibre.bookmark ? [calibre.bookmark] : []
        });

        Object.keys(themes).forEach(function (themeName) {
            reader.rendition.themes.register(themeName, themes[themeName].css_path);
        });

        try {
            reader.rendition.flow("scrolled-doc");
            reader.rendition.spread("none");
        } catch (e) {}

        if (calibre.useBookmarks) {
            reader.on("reader:bookmarked", updateBookmark.bind(reader, "add"));
            reader.on("reader:unbookmarked", updateBookmark.bind(reader, "remove"));
        } else {
            $("#bookmark, #show-Bookmarks").remove();
        }

        reader.book.ready.then(function () {
            var locationsKey = reader.book.key() + "-locations";
            var positionKey = "calibre.reader.position." + reader.book.key();
            var storedLocations = localStorage.getItem(locationsKey);
            var makeLocations;
            var saveLocations;

            if (storedLocations) {
                makeLocations = Promise.resolve(reader.book.locations.load(storedLocations));
                saveLocations = function () {};
            } else {
                makeLocations = reader.book.locations.generate();
                saveLocations = function () {
                    localStorage.setItem(locationsKey, reader.book.locations.save());
                };
            }

            makeLocations.then(function () {
                var savedPosition = localStorage.getItem(positionKey);
                if (savedPosition) {
                    try {
                        var parsed = JSON.parse(savedPosition);
                        if (parsed && parsed.cfi) {
                            reader.rendition.display(parsed.cfi);
                        }
                    } catch (e) {}
                }

                reader.rendition.on("relocated", function (location) {
                    var percentage = Math.round(location.end.percentage * 100);
                    $progress.text(percentage + "%");
                    chapterAdvanceCooldownUntil = Date.now() + 600;

                    var cfi = location.start.cfi;
                    var current = reader.book.locations.locationFromCfi(cfi) || 0;
                    var total = reader.book.locations.length() || 0;
                    if (total > 0) {
                        $pages.text(current + "/" + total);
                    } else {
                        $pages.text("");
                    }
                    schedulePositionPersist(positionKey, location);
                    if (location && location.start && location.start.href) {
                        updateActiveChapterByHref(location.start.href);
                    }
                });

                reader.rendition.on("rendered", function () {
                    applyTypographyToRendition();
                });

                reader.rendition.reportLocation();
                $progress.css("visibility", "visible");
            }).then(saveLocations);
        });

        reader.book.loaded.navigation.then(function (navigation) {
            chapterItems = flattenToc(navigation && navigation.toc ? navigation.toc : [], []);
            $chapterSelect.empty();
            if (!chapterItems.length) {
                $("<option>").val("-1").text(emptyChapterLabel).appendTo($chapterSelect);
                return;
            }
            chapterItems.forEach(function (item, index) {
                $("<option>").val(String(index)).text(item.label).appendTo($chapterSelect);
            });
            activeChapterIndex = 0;
            $chapterSelect.val("0");
        });
    }

    loadState();
    updateControlsFromState();
    bindControls();
    initializeReader();
    applyTheme(state.theme);
    applyTypographyToRendition();
    startTicker();
})();
