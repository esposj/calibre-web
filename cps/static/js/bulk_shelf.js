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
    var $csrf = $("input[name='csrf_token']").first();
    var selectedLabel = $toolbar.data("bulkSelectedLabel") || "selected";
    var actionLabel = $toolbar.data("bulkActionLabel") || "Add selected to shelf";
    var errorLabel = $toolbar.data("bulkErrorLabel") || "Could not prepare selected books for bulk shelf action";

    function showBulkError(text) {
        $("#flash_bulk_error").closest(".row-fluid.text-center").remove();
        $(".navbar").after(
            "<div class=\"row-fluid text-center\">" +
                "<div id=\"flash_bulk_error\" class=\"alert alert-danger\">" + text + "</div>" +
            "</div>"
        );
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
            } else {
                if ($link.attr("data-bulk-role")) {
                    $link.attr("role", $link.attr("data-bulk-role"));
                    $link.removeAttr("data-bulk-role");
                } else {
                    $link.removeAttr("role");
                }
                $link.removeAttr("aria-pressed");
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
        var hasSelection = selectedIds.length > 0;
        $bulkCount.text(selectedIds.length + " " + selectedLabel);
        $bulkClear.prop("disabled", !hasSelection);
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
        if (!enabled) {
            resetSelection();
        }
        refreshControls();
    }

    function toggleBookSelectionByLink($link) {
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

    $bulkToggle.on("click", function() {
        setBulkMode(!bulkModeEnabled);
    });

    $bulkClear.on("click", function() {
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
