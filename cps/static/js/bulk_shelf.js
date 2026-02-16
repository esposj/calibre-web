/* This file is part of the Calibre-Web (https://github.com/janeczku/calibre-web)
 *    Copyright (C) 2026
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 */

/* global getPath */

$(function() {
    var $toolbar = $("[data-bulk-shelf-toolbar]").first();
    if (!$toolbar.length) {
        return;
    }

    var selectedIds = [];
    var bulkModeEnabled = false;

    var $bulkToggle = $toolbar.find("[data-bulk-toggle]");
    var $bulkControls = $toolbar.find("[data-bulk-controls]");
    var $bulkCount = $toolbar.find("[data-bulk-count]");
    var $bulkShelfSelect = $toolbar.find("[data-bulk-shelf-select]");
    var $bulkAdd = $toolbar.find("[data-bulk-add]");
    var $bulkClear = $toolbar.find("[data-bulk-clear]");
    var $bulkSelectAll = $toolbar.find("[data-bulk-select-all]");
    var $bulkSelectNone = $toolbar.find("[data-bulk-select-none]");
    var $csrf = $("input[name='csrf_token']").first();
    var selectedLabel = $toolbar.data("bulkSelectedLabel") || "selected";
    var actionLabel = $toolbar.data("bulkActionLabel") || "Add selected to shelf";
    var errorLabel = $toolbar.data("bulkErrorLabel") || "Could not prepare selected books for bulk shelf action";
    var activeIndex = -1;

    function showBulkError(text) {
        $("#flash_bulk_error").closest(".row-fluid.text-center").remove();
        $(".navbar").after(
            "<div class=\"row-fluid text-center\">" +
                "<div id=\"flash_bulk_error\" class=\"alert alert-danger\">" + text + "</div>" +
            "</div>"
        );
    }

    function getBulkLinks() {
        return $("[data-bulk-book-id] .bulk-cover-link").filter(":visible");
    }

    function setActiveLink(index, focusLink) {
        var $links = getBulkLinks();
        if (!$links.length) {
            activeIndex = -1;
            return;
        }

        if (index < 0) {
            index = 0;
        }
        if (index >= $links.length) {
            index = $links.length - 1;
        }

        $links.removeClass("bulk-key-active").attr("tabindex", "-1");
        var $link = $links.eq(index);
        $link.addClass("bulk-key-active").attr("tabindex", "0");
        activeIndex = index;

        if (focusLink) {
            $link.focus();
            if ($link[0] && $link[0].scrollIntoView) {
                $link[0].scrollIntoView({block: "nearest", inline: "nearest"});
            }
        }
    }

    function getCurrentActiveIndex() {
        var $links = getBulkLinks();
        if (!$links.length) {
            return -1;
        }
        if (activeIndex >= 0 && activeIndex < $links.length) {
            return activeIndex;
        }
        var focusedIndex = $links.index(document.activeElement);
        return focusedIndex > -1 ? focusedIndex : 0;
    }

    function toggleMetaLinks(disabled) {
        $("[data-bulk-book-id] .meta a").each(function() {
            var $link = $(this);
            if (disabled) {
                if ($link.attr("tabindex")) {
                    $link.attr("data-bulk-tabindex", $link.attr("tabindex"));
                }
                $link.attr("tabindex", "-1");
                $link.attr("aria-disabled", "true");
            } else {
                if ($link.attr("data-bulk-tabindex")) {
                    $link.attr("tabindex", $link.attr("data-bulk-tabindex"));
                    $link.removeAttr("data-bulk-tabindex");
                } else {
                    $link.removeAttr("tabindex");
                }
                $link.removeAttr("aria-disabled");
            }
        });
    }

    function toggleModalLinks(disabled) {
        $(".bulk-cover-link").each(function() {
            var $link = $(this);
            if (disabled) {
                if ($link.attr("data-toggle")) {
                    $link.attr("data-bulk-toggle", $link.attr("data-toggle"));
                    $link.removeAttr("data-toggle");
                }
                if ($link.attr("data-target")) {
                    $link.attr("data-bulk-target", $link.attr("data-target"));
                    $link.removeAttr("data-target");
                }
            } else {
                if ($link.attr("data-bulk-toggle")) {
                    $link.attr("data-toggle", $link.attr("data-bulk-toggle"));
                    $link.removeAttr("data-bulk-toggle");
                }
                if ($link.attr("data-bulk-target")) {
                    $link.attr("data-target", $link.attr("data-bulk-target"));
                    $link.removeAttr("data-bulk-target");
                }
            }
        });
    }

    function toggleA11y(disabled) {
        $(".bulk-cover-link").each(function() {
            var $link = $(this);
            if (disabled) {
                if ($link.attr("role")) {
                    $link.attr("data-bulk-role", $link.attr("role"));
                }
                $link.attr("role", "button");
                $link.attr("aria-pressed", "false");
                $link.attr("tabindex", "-1");
            } else {
                if ($link.attr("data-bulk-role")) {
                    $link.attr("role", $link.attr("data-bulk-role"));
                    $link.removeAttr("data-bulk-role");
                } else {
                    $link.removeAttr("role");
                }
                $link.removeAttr("aria-pressed");
                $link.removeClass("bulk-key-active");
                $link.removeAttr("tabindex");
            }
        });
    }

    function setSelected(bookId, selected) {
        var $book = $("[data-bulk-book-id='" + bookId + "']");
        if (selected) {
            $book.addClass("bulk-selected");
        } else {
            $book.removeClass("bulk-selected");
        }
        $book.find(".bulk-cover-link").attr("aria-pressed", selected ? "true" : "false");
    }

    function resetSelection() {
        selectedIds.forEach(function(id) {
            setSelected(id, false);
        });
        selectedIds = [];
    }

    function refreshControls() {
        var visibleBookIds = $("[data-bulk-book-id]:visible").map(function() {
            return parseInt($(this).data("bulkBookId"), 10);
        }).get().filter(function(id) {
            return !!id;
        });
        var hasVisibleBooks = visibleBookIds.length > 0;
        var allVisibleSelected = hasVisibleBooks && visibleBookIds.every(function(id) {
            return $.inArray(id, selectedIds) > -1;
        });
        var hasSelection = selectedIds.length > 0;
        $bulkCount.text(selectedIds.length + " " + selectedLabel);
        $bulkClear.prop("disabled", !hasSelection);
        $bulkSelectAll.prop("disabled", !hasVisibleBooks || allVisibleSelected);
        $bulkSelectNone.prop("disabled", !hasSelection);
        $bulkAdd.prop("disabled", !hasSelection || !$bulkShelfSelect.val());
        $bulkAdd.text(actionLabel);
    }

    function setBulkMode(enabled) {
        bulkModeEnabled = enabled;
        $("body").toggleClass("bulk-shelf-mode", enabled);
        $("[data-bulk-book-id]").toggleClass("bulk-select-enabled", enabled);
        $bulkControls.toggleClass("hidden", !enabled);
        $bulkToggle.toggleClass("active", enabled);
        toggleModalLinks(enabled);
        toggleA11y(enabled);
        toggleMetaLinks(enabled);
        if (enabled) {
            setActiveLink(0, true);
        } else {
            activeIndex = -1;
        }
        if (!enabled) {
            resetSelection();
        }
        refreshControls();
    }

    function toggleBookSelectionByLink($link) {
        var focusedIndex = getBulkLinks().index($link);
        if (focusedIndex > -1) {
            setActiveLink(focusedIndex, false);
        }

        var bookId = parseInt($link.closest("[data-bulk-book-id]").data("bulkBookId"), 10);
        if (!bookId) {
            return;
        }
        var existingIndex = $.inArray(bookId, selectedIds);
        if (existingIndex > -1) {
            selectedIds.splice(existingIndex, 1);
            setSelected(bookId, false);
        } else {
            selectedIds.push(bookId);
            setSelected(bookId, true);
        }
        refreshControls();
    }

    $(document).on("click", ".bulk-cover-link", function(e) {
        if (!bulkModeEnabled) {
            return;
        }

        e.preventDefault();
        e.stopImmediatePropagation();
        toggleBookSelectionByLink($(this));
    });

    $(document).on("keydown", ".bulk-cover-link", function(e) {
        if (!bulkModeEnabled) {
            return;
        }
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopImmediatePropagation();
            toggleBookSelectionByLink($(this));
        }
    });

    $(document).on("keydown", function(e) {
        if (!bulkModeEnabled) {
            return;
        }
        if ($(e.target).is("input, textarea, select, [contenteditable='true']")) {
            return;
        }

        var key = e.key;
        if (key === "Escape") {
            e.preventDefault();
            setBulkMode(false);
            return;
        }
        if (key !== "ArrowDown" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowLeft") {
            return;
        }

        e.preventDefault();
        e.stopImmediatePropagation();

        var currentIndex = getCurrentActiveIndex();
        if (currentIndex < 0) {
            return;
        }
        var step = (key === "ArrowDown" || key === "ArrowRight") ? 1 : -1;
        setActiveLink(currentIndex + step, true);
    });

    $(document).on("click", "[data-bulk-book-id] .meta a", function(e) {
        if (!bulkModeEnabled) {
            return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        var $coverLink = $(this).closest("[data-bulk-book-id]").find(".bulk-cover-link").first();
        if ($coverLink.length) {
            toggleBookSelectionByLink($coverLink);
        }
    });

    $(document).on("keydown", "[data-bulk-book-id] .meta a", function(e) {
        if (!bulkModeEnabled) {
            return;
        }
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopImmediatePropagation();
            var $coverLink = $(this).closest("[data-bulk-book-id]").find(".bulk-cover-link").first();
            if ($coverLink.length) {
                toggleBookSelectionByLink($coverLink);
            }
        }
    });

    $bulkToggle.on("click", function() {
        setBulkMode(!bulkModeEnabled);
    });

    $bulkClear.on("click", function() {
        resetSelection();
        refreshControls();
    });

    $bulkSelectAll.on("click", function() {
        if (!bulkModeEnabled) {
            return;
        }
        $("[data-bulk-book-id]:visible").each(function() {
            var bookId = parseInt($(this).data("bulkBookId"), 10);
            if (!bookId || $.inArray(bookId, selectedIds) > -1) {
                return;
            }
            selectedIds.push(bookId);
            setSelected(bookId, true);
        });
        refreshControls();
    });

    $bulkSelectNone.on("click", function() {
        resetSelection();
        refreshControls();
    });

    $bulkShelfSelect.on("change", refreshControls);

    $bulkAdd.on("click", function() {
        var shelfId = $bulkShelfSelect.val();
        if (!shelfId || !selectedIds.length) {
            refreshControls();
            return;
        }

        $.ajax({
            method: "post",
            url: getPath() + "/ajax/selectedbooks",
            contentType: "application/json; charset=utf-8",
            dataType: "json",
            data: JSON.stringify({book_ids: selectedIds}),
            success: function() {
                var $form = $("<form>", {
                    action: getPath() + "/shelf/massadd/" + shelfId,
                    method: "post",
                    target: "_top"
                }).append($("<input>", {
                    name: "csrf_token",
                    type: "hidden",
                    value: $csrf.val()
                }));
                $("body").append($form);
                $form.submit();
            },
            error: function() {
                showBulkError(errorLabel);
            }
        });
    });

    refreshControls();
});
