#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'extension.js');
let source = fs.readFileSync(sourcePath, 'utf8');

source = source
    .replace(/^import .*;\n/gm, '')
    .replace('export default class GnomeAssistantExtension extends Extension', 'class GnomeAssistantExtension extends Extension');

source += '\nthis.GnomeAssistantExtension = GnomeAssistantExtension;\n';

const context = {
    Extension: class {},
    console,
    // Imports are stripped; the name helper falls back to its default here.
    assistantName: () => 'GNOME Assistant',
    // disable() closes a shown area or window picker.
    cancelPick: () => {},
};
vm.createContext(context);
vm.runInContext(source, context, {filename: sourcePath});

function createExtension(searchActive = false, searchText = '', options = {}) {
    const extension = new context.GnomeAssistantExtension();
    const controller = {searchActive};
    let setSearchEntryTextCalls = 0;
    let currentSearchText = searchText;
    const throwOnSetSearchText = options.throwOnSetSearchText ?? true;

    Object.assign(extension, {
        _isAiMode: false,
        _isSubmitting: false,
        _searchController: controller,
        _aiButton: null,
        _usesPrimaryIcon: false,
        _icon: {destroy() {}},
        _aiIcon: {},
        _originalSearchPlaceholder: 'Search',
        _aiView: {visible: false, reactive: false, destroy() {}},
        _setEntryIcon() {},
        _setSearchPlaceholder() {},
        _syncModeVisibility() {},
        _scheduleVisibilityReassertion() {},
        _cancelVisibilityReassertion() {},
        _getSearchEntryText() {
            return currentSearchText;
        },
        _setSearchEntryText(value) {
            setSearchEntryTextCalls++;
            if (throwOnSetSearchText)
                throw new Error('AI mode toggle must not mutate the search entry text');

            currentSearchText = String(value ?? '');
        },
    });

    return {
        extension,
        controller,
        get searchText() {
            return currentSearchText;
        },
        get setSearchEntryTextCalls() {
            return setSearchEntryTextCalls;
        },
    };
}

function createVisibilityExtension(searchText = '', hasAiInteraction = false) {
    const extension = new context.GnomeAssistantExtension();
    const searchActor = {
        visible: true,
        opacity: 255,
        reactive: true,
    };
    const aiView = {
        visible: false,
        reactive: false,
    };

    Object.assign(extension, {
        _isAiMode: true,
        _isSubmitting: false,
        _aiView: aiView,
        _searchResultsActor: searchActor,
        _searchController: {searchActive: false},
        _getSearchEntryText() {
            return searchText;
        },
        _isOverviewTargetVisible() {
            return true;
        },
        _raiseAiView() {},
        _ensureVisibleChain() {},
    });

    return {extension, searchActor, aiView};
}

{
    const harness = createExtension(false);
    harness.extension._setAiMode(true);

    assert.equal(harness.extension._isAiMode, true);
    assert.equal(harness.controller.searchActive, false);
    assert.equal(harness.setSearchEntryTextCalls, 0);
}

{
    const harness = createExtension(false, '');
    harness.extension._setAiMode(true);
    harness.extension._setAiMode(false);

    assert.equal(harness.extension._isAiMode, false);
    assert.equal(harness.controller.searchActive, false);
}

{
    const harness = createExtension(false, 'native query');
    harness.extension._setAiMode(true);
    harness.extension._setAiMode(false);

    assert.equal(harness.controller.searchActive, true);
}

{
    const harness = createExtension(false, '');
    harness.extension._setAiMode(true);
    harness.extension.disable();

    assert.equal(harness.controller.searchActive, false);
    assert.equal(harness.extension._isAiMode, false);
}

{
    const harness = createVisibilityExtension('');
    harness.extension._syncModeVisibility();

    assert.equal(harness.aiView.visible, true);
    assert.equal(harness.searchActor.visible, true);
    assert.equal(harness.searchActor.opacity, 0);
    assert.equal(harness.searchActor.reactive, false);
    assert.equal(harness.extension._searchController.searchActive, true);
}

{
    const harness = createVisibilityExtension('ask ai');
    harness.extension._syncModeVisibility();

    assert.equal(harness.aiView.visible, true);
    assert.equal(harness.searchActor.visible, true);
    assert.equal(harness.searchActor.opacity, 0);
    assert.equal(harness.searchActor.reactive, false);
    assert.equal(harness.extension._searchController.searchActive, true);
}

{
    const {extension, aiView, searchActor} = createVisibilityExtension('ask Codex');
    const controller = {
        _searchActive: false,
        get searchActive() {
            return this._searchActive;
        },
        _setSearchActive(active) {
            this._searchActive = active;
        },
    };
    extension._searchController = controller;

    extension._syncModeVisibility();

    assert.equal(controller.searchActive, true);
    assert.equal(aiView.visible, true);
    assert.equal(searchActor.opacity, 0);

    extension._setOverviewSearchActive(false);
    assert.equal(controller.searchActive, false);
}

{
    const {extension} = createExtension();
    const Clutter = context.Clutter = {
        KEY_Super_L: 1,
        KEY_Escape: 2,
        EVENT_PROPAGATE: false,
        EVENT_STOP: true,
    };
    extension._setAiMode(true);

    assert.equal(extension._handleAiModeKeyEvent({get_key_symbol: () => Clutter.KEY_Super_L}),
        Clutter.EVENT_PROPAGATE);
    assert.equal(extension._isAiMode, true);

    assert.equal(extension._handleAiModeKeyEvent({get_key_symbol: () => Clutter.KEY_Escape}),
        Clutter.EVENT_STOP);
    assert.equal(extension._isAiMode, false);
}

(async () => {
    let searchText = 'ask ai';
    let queuedVisibilitySync = false;
    const messages = [];
    const responses = [];
    const extension = new context.GnomeAssistantExtension();

    Object.assign(extension, {
        _isAiMode: true,
        _isSubmitting: false,
        _aiView: {
            visible: false,
            addMessage(sender, text) {
                messages.push([sender, text]);
            },
            async generateResponse(prompt) {
                responses.push(prompt);
            },
            // Nothing secret in these prompts: the review lets them through.
            async reviewOutgoing(prompt) {
                return {proceed: true, prompt};
            },
        },
        _getSearchEntryText() {
            return searchText;
        },
        _setSearchEntryText(value) {
            searchText = String(value ?? '');
        },
        _syncModeVisibility() {},
        _queueModeVisibilitySync() {
            queuedVisibilitySync = true;
        },
    });

    await extension._submitAiPrompt();

    assert.equal(searchText, '');
    assert.deepEqual(messages, [['You', 'ask ai']]);
    assert.deepEqual(responses, ['ask ai']);
    assert.equal(queuedVisibilitySync, true);
    assert.equal(extension._isSubmitting, false);

    console.log('[PASS] Codex clears the entry and keeps the overview panel available');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
