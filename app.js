// Google tag (gtag.js) bootstrap; the loader script is in index.html.
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-553V1C3J93', {
    allow_google_signals: false,
    allow_ad_personalization_signals: false
});

// --- Constants & Config ---
const MAX_PLAYERS = 56;
const ELIMINATION_THRESHOLD = 56;
const LOCAL_STORAGE_OFFLINE_KEY = 'offlineGameState';
const LOCAL_STORAGE_HISTORY_KEY = 'completedGames';
const LOCAL_STORAGE_THEME_KEY = 'theme';
const HANDOFF_COMPRESSED_PREFIX = '14HIGHZ:';
// Generous caps: a full 56-player, 14-round game is well under these.
const HANDOFF_MAX_COMPRESSED_LENGTH = 200000;
const HANDOFF_MAX_JSON_LENGTH = 1000000;
const MAX_ROUND_HISTORY = 14;

// --- Safe storage ---
// Blocked (private mode, disabled site data), full or corrupt storage must never stop the app.
function readStorage(key) {
    try {
        return localStorage.getItem(key);
    } catch (err) {
        console.warn('Storage unavailable:', err);
        return null;
    }
}

function isQuotaError(err) {
    return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        err.code === 22 || err.code === 1014);
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, value);
        return { saved: true, full: false };
    } catch (err) {
        console.error(`Could not save ${key}:`, err);
        return { saved: false, full: isQuotaError(err) };
    }
}

function removeStorage(key) {
    try {
        localStorage.removeItem(key);
    } catch (err) {
        console.warn('Storage unavailable:', err);
    }
}

function readStoredJSON(key) {
    const raw = readStorage(key);
    if (raw === null) return null;
    try {
        return JSON.parse(raw);
    } catch (err) {
        console.error(`Ignoring unreadable ${key}:`, err);
        return null;
    }
}

// --- Game data validation ---
// Saved and imported games are untrusted: every value that reaches the page or
// the scoring must have the expected type. Names matching Object.prototype
// members (e.g. "__proto__", "constructor") cannot be used as object keys.
function isReservedKey(key) {
    return key in Object.prototype;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHandCount(value) {
    return Number.isInteger(value) && value >= 0 && value <= 14;
}

function isScoreValue(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function sanitizePlayerNames(list) {
    if (!Array.isArray(list)) return [];
    const names = [];
    const seen = new Set();
    for (const entry of list) {
        const name = String(entry || '').trim();
        if (!name || seen.has(name) || isReservedKey(name)) continue;
        seen.add(name);
        names.push(name);
        if (names.length === MAX_PLAYERS) break;
    }
    return names;
}

function sanitizeValueMap(source, isValid) {
    const result = {};
    if (!isPlainObject(source)) return result;
    Object.keys(source).forEach(key => {
        if (!isReservedKey(key) && isValid(source[key])) result[key] = source[key];
    });
    return result;
}

function normalizeDealerIndex(value, playerCount) {
    if (!Number.isInteger(value) || playerCount === 0) return 0;
    return ((value % playerCount) + playerCount) % playerCount;
}

function copyOwnFields(source) {
    const copy = {};
    Object.keys(source).forEach(key => {
        if (!isReservedKey(key)) copy[key] = source[key];
    });
    return copy;
}

function sanitizeRoundEntry(entry) {
    if (!isPlainObject(entry)) return null;
    const clean = copyOwnFields(entry);
    const has = key => Object.prototype.hasOwnProperty.call(clean, key);
    ['players', 'eliminatedPlayers'].forEach(key => {
        if (!has(key)) return;
        if (Array.isArray(clean[key])) clean[key] = sanitizePlayerNames(clean[key]);
        else delete clean[key];
    });
    if (has('currentRound') && !(Number.isInteger(clean.currentRound) && clean.currentRound >= 1 && clean.currentRound <= 14)) {
        delete clean.currentRound;
    }
    if (has('dealerIndex') && !Number.isInteger(clean.dealerIndex)) delete clean.dealerIndex;
    if (has('bidPhase') && typeof clean.bidPhase !== 'boolean') delete clean.bidPhase;
    clean.bids = sanitizeValueMap(entry.bids, isHandCount);
    clean.tricks = sanitizeValueMap(entry.tricks, isHandCount);
    clean.scores = sanitizeValueMap(entry.scores, isScoreValue);
    return clean;
}

function sanitizeRoundHistory(list) {
    if (!Array.isArray(list)) return [];
    return list.map(sanitizeRoundEntry).filter(Boolean).slice(-MAX_ROUND_HISTORY);
}

function sanitizeGameState(raw) {
    const source = isPlainObject(raw) ? raw : {};
    const players = sanitizePlayerNames(source.players);
    const numericRound = Number(source.currentRound);
    return {
        ...getDefaultOfflineState(),
        players,
        gameStarted: source.gameStarted === true,
        currentRound: Number.isFinite(numericRound) ? Math.min(Math.max(Math.trunc(numericRound), 1), 15) : 1,
        dealerIndex: normalizeDealerIndex(source.dealerIndex, players.length),
        bids: sanitizeValueMap(source.bids, isHandCount),
        tricks: sanitizeValueMap(source.tricks, isHandCount),
        scores: sanitizeValueMap(source.scores, isScoreValue),
        bidPhase: source.bidPhase !== false,
        eliminatedPlayers: sanitizePlayerNames(source.eliminatedPlayers),
        roundHistory: sanitizeRoundHistory(source.roundHistory)
    };
}

function sanitizeCompletedGame(game) {
    if (!isPlainObject(game)) return null;
    const clean = copyOwnFields(game);
    clean.winners = sanitizePlayerNames(game.winners);
    clean.players = sanitizePlayerNames(game.players);
    clean.eliminatedPlayers = sanitizePlayerNames(game.eliminatedPlayers);
    clean.finalScores = sanitizeValueMap(game.finalScores, isScoreValue);
    clean.score = isScoreValue(game.score) ? game.score : 0;
    if (typeof clean.date !== 'string' && typeof clean.date !== 'number') clean.date = null;
    if (Object.prototype.hasOwnProperty.call(clean, 'roundHistory')) {
        if (Array.isArray(clean.roundHistory)) clean.roundHistory = sanitizeRoundHistory(clean.roundHistory);
        else delete clean.roundHistory;
    }
    return clean;
}

// LZString.decompressFromEncodedURIComponent (lz-string 1.4.4, MIT) with an
// output cap: a short crafted link could otherwise expand into gigabytes and
// freeze or crash the tab. tests/handoff.test.mjs checks it against the library.
const LZ_URI_SAFE_VALUES = new Map(Array.from(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$', (char, index) => [char, index]));

function decompressHandoffData(input, maxLength = HANDOFF_MAX_JSON_LENGTH) {
    if (input === null || input === undefined) return '';
    if (input === '') return null;
    const text = String(input).replace(/ /g, '+');
    const data = { val: LZ_URI_SAFE_VALUES.get(text.charAt(0)), position: 32, index: 1 };
    const readBits = count => {
        let bits = 0;
        const maxpower = Math.pow(2, count);
        let power = 1;
        while (power !== maxpower) {
            const resb = data.val & data.position;
            data.position >>= 1;
            if (data.position === 0) {
                data.position = 32;
                data.val = LZ_URI_SAFE_VALUES.get(text.charAt(data.index++));
            }
            bits |= (resb > 0 ? 1 : 0) * power;
            power <<= 1;
        }
        return bits;
    };
    const dictionary = [0, 1, 2];
    const result = [];
    let enlargeIn = 4;
    let dictSize = 4;
    let numBits = 3;
    let c;
    switch (readBits(2)) {
        case 0: c = String.fromCharCode(readBits(8)); break;
        case 1: c = String.fromCharCode(readBits(16)); break;
        case 2: return '';
    }
    dictionary[3] = c;
    let w = c;
    let outputLength = c ? c.length : 0;
    result.push(c);
    while (true) {
        if (data.index > text.length) return '';
        let code = readBits(numBits);
        switch (code) {
            case 0:
                dictionary[dictSize++] = String.fromCharCode(readBits(8));
                code = dictSize - 1;
                enlargeIn--;
                break;
            case 1:
                dictionary[dictSize++] = String.fromCharCode(readBits(16));
                code = dictSize - 1;
                enlargeIn--;
                break;
            case 2:
                return result.join('');
        }
        if (enlargeIn === 0) {
            enlargeIn = Math.pow(2, numBits);
            numBits++;
        }
        let entry;
        if (dictionary[code]) {
            entry = dictionary[code];
        } else if (code === dictSize) {
            entry = w + w.charAt(0);
        } else {
            return null;
        }
        outputLength += entry.length;
        if (outputLength > maxLength) throw new Error('Import data is too large.');
        result.push(entry);
        dictionary[dictSize++] = w + entry.charAt(0);
        enlargeIn--;
        w = entry;
        if (enlargeIn === 0) {
            enlargeIn = Math.pow(2, numBits);
            numBits++;
        }
    }
}

function getSafeAnalyticsParams(params = {}) {
    const numericKeys = new Set([
        'player_count',
        'round_number',
        'round_count',
        'eliminated_count',
        'winner_count'
    ]);
    const booleanKeys = new Set(['qr_available']);
    const allowedStringValues = {
        transfer_method: new Set(['qr', 'copy_data']),
        import_source: new Set(['url', 'qr', 'paste'])
    };
    const safeParams = {};

    Object.entries(params || {}).forEach(([key, value]) => {
        if (numericKeys.has(key) && typeof value === 'number' && Number.isFinite(value)) {
            safeParams[key] = value;
        } else if (booleanKeys.has(key) && typeof value === 'boolean') {
            safeParams[key] = value;
        } else if (allowedStringValues[key] && allowedStringValues[key].has(value)) {
            safeParams[key] = value;
        }
    });

    return safeParams;
}

function trackAnalyticsEvent(eventName, params = {}) {
    if (
        typeof eventName !== 'string' ||
        eventName.length > 40 ||
        !/^[a-z][a-z0-9_]*$/.test(eventName)
    ) return false;
    if (typeof window.gtag !== 'function') return false;
    window.gtag('event', eventName, getSafeAnalyticsParams(params));
    return true;
}

// --- Global State ---
let currentMode = 'entry'; // 'entry' or 'offline'
let offlineState = {};
let localHistory = [];
let previousHtml = ''; // Track previous HTML for diffing
let darkMode = false;
let pendingImportNotice = null;

// --- DOM Elements ---
const app = document.getElementById('app');
const hamburgerBtn = document.querySelector('.hamburger-btn');
const menuContent = document.querySelector('.menu-content');
const menuClose = document.querySelector('.menu-close');
const menuBackButton = document.getElementById('menu-back-button');
const darkModeToggle = document.getElementById('dark-mode-toggle');
const completedGamesList = document.getElementById('completed-games-list');
const body = document.body;
const versionBadge = document.getElementById('version-badge');
const versionModal = document.getElementById('version-modal');
const versionClose = document.getElementById('version-close');
const eliminationBanner = document.getElementById('elimination-banner');
const handoffImportBanner = document.getElementById('handoff-import-banner');
const gameDetailsModal = document.getElementById('game-details-modal');
const gameDetailsClose = document.getElementById('game-details-close');
const gameDetailsBody = document.getElementById('game-details-body');

function setMenuOpen(isOpen) {
    if (!menuContent || !hamburgerBtn) return;
    menuContent.classList.toggle('active', isOpen);
    menuContent.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    hamburgerBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    menuContent.inert = !isOpen;
}

// --- Initialization ---
function initializeApp() {
    // Check for QR import via URL param
    const urlParams = new URLSearchParams(window.location.search);
    const importData = urlParams.get('import');
    if (importData) {
        try {
            const parsed = parseCompressedHandoffState(importData);
            const importedState = importOfflineGameState(parsed);
            // Clear the URL param so refresh doesn't re-import
            window.history.replaceState({}, '', window.location.pathname + window.location.hash);
            currentMode = 'offline';
            pendingImportNotice = {
                type: 'success',
                message: getImportSuccessMessage(importedState)
            };
            trackAnalyticsEvent('handoff_imported', {
                import_source: 'url',
                player_count: importedState.players.length,
                round_number: importedState.currentRound
            });
        } catch (err) {
            console.error('Failed to import from URL:', err);
            pendingImportNotice = {
                type: 'error',
                message: err.message || 'Failed to import game data.'
            };
        }
    }

    const savedTheme = readStorage(LOCAL_STORAGE_THEME_KEY);
    if (savedTheme === 'dark') {
        darkMode = true;
        if (darkModeToggle) darkModeToggle.checked = true;
        applyTheme('dark');
    } else {
        applyTheme('light');
    }

    loadLocalHistory();
    renderApp();
    if (pendingImportNotice) {
        showHandoffImportNotice(pendingImportNotice.message, pendingImportNotice.type);
        pendingImportNotice = null;
    }
    menuBackButton.style.display = 'none';

    app.addEventListener('click', handleAppClick);
    app.addEventListener('keypress', handleAppKeyPress);
    app.addEventListener('input', handleAppInput);
    app.addEventListener('focusin', (e) => {
        if (e.target.matches('input[type=\"number\"], input[type=\"text\"]')) {
            e.target.select();
        }
    });

    setMenuOpen(false);
    hamburgerBtn.addEventListener('click', () => setMenuOpen(true));
    menuClose.addEventListener('click', () => setMenuOpen(false));
    menuBackButton.addEventListener('click', goBackToEntry);

    document.addEventListener('click', (e) => {
        if (menuContent.classList.contains('active') && !menuContent.contains(e.target) && !hamburgerBtn.contains(e.target)) {
            setMenuOpen(false);
        }
        if (versionModal.classList.contains('active') && !versionModal.contains(e.target) && !versionBadge.contains(e.target)) {
            versionModal.classList.remove('active');
        }
        if (gameDetailsModal.classList.contains('active') && e.target === gameDetailsModal) {
            closeGameDetailsModal();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (menuContent.classList.contains('active')) setMenuOpen(false);
            if (versionModal.classList.contains('active')) versionModal.classList.remove('active');
            if (gameDetailsModal.classList.contains('active')) closeGameDetailsModal();
        }
    });

    if (darkModeToggle) {
        darkModeToggle.addEventListener('change', () => applyTheme(darkModeToggle.checked ? 'dark' : 'light'));
    }

    if (versionBadge) {
        versionBadge.addEventListener('click', (e) => {
            e.stopPropagation();
            versionModal.classList.add('active');
        });
    }
    if (versionClose) {
        versionClose.addEventListener('click', () => versionModal.classList.remove('active'));
    }

    if (gameDetailsClose) {
        gameDetailsClose.addEventListener('click', closeGameDetailsModal);
    }
    if (completedGamesList) {
        completedGamesList.addEventListener('click', (e) => {
            const gameItem = e.target.closest('.completed-game-item');
            if (gameItem) {
                const gameIndex = parseInt(gameItem.getAttribute('data-game-index'));
                if (!isNaN(gameIndex)) showGameDetails(gameIndex);
            }
        });
    }
    if (gameDetailsModal) {
        gameDetailsModal.addEventListener('click', (e) => {
            if (e.target === gameDetailsModal) closeGameDetailsModal();
        });
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && currentMode === 'offline' && offlineState.gameStarted) {
            checkUpcomingElimination(offlineState);
        }
    });

    if (eliminationBanner) {
        eliminationBanner.addEventListener('click', (e) => {
            if (e.target.closest('.elimination-dismiss')) {
                eliminationBanner.style.display = 'none';
            }
        });
    }

    document.body.addEventListener('click', (e) => {
        if (e.target.closest('#handoff-qr-btn')) {
            showHandoffQRModal();
        }
        if (e.target.closest('#handoff-import-btn')) {
            showHandoffImportModal();
        }
    });
}

// --- Mode Selection & Switching ---
function selectMode(mode) {
    hideEliminationBanner();
    if (mode === 'offline') {
        currentMode = 'offline';
        loadOfflineState();
        menuBackButton.style.display = 'block';
        renderApp();
    } else { // Go back to entry
        currentMode = 'entry';
        offlineState = {}; // Clear offline state
        menuBackButton.style.display = 'none';
        renderApp();
    }
}

// Check if there's a saved offline game in localStorage
function hasSavedOfflineGame() {
    const savedState = readStoredJSON(LOCAL_STORAGE_OFFLINE_KEY);
    if (!savedState) return false;
    const state = sanitizeGameState(savedState);
    // Check if the game was actually started and has players
    return state.gameStarted && state.players.length >= 2;
}

function goBackToEntry() {
    if (currentMode === 'offline') {
        if (!offlineState.gameStarted || confirm("Are you sure you want to leave this offline game? Progress might be saved.")) {
            selectMode('entry');
        }
    } else {
        selectMode('entry');
    }
    setMenuOpen(false);
}
// --- Event Handlers (Delegated) ---
function handleAppClick(e) {
    const target = e.target;

    if (target.closest('#select-offline-btn')) {
        selectMode('offline');
        return;
    }

    if (target.closest('#back-to-menu-btn')) {
        goBackToEntry();
        return;
    }

    if (currentMode !== 'offline') {
        return;
    }

    if (!offlineState.gameStarted) {
        if (target.closest('#add-player-btn')) {
            addPlayerOffline();
            return;
        }

        const removeBtn = target.closest('.btn-remove');
        if (removeBtn) {
            const player = removeBtn.getAttribute('data-player');
            if (player) removePlayerOffline(player);
            return;
        }

        const moveUpBtn = target.closest('.btn-move-up');
        if (moveUpBtn) {
            const player = moveUpBtn.getAttribute('data-player');
            if (player) {
                const idx = offlineState.players.indexOf(player);
                if (idx > 0) {
                    [offlineState.players[idx - 1], offlineState.players[idx]] = [offlineState.players[idx], offlineState.players[idx - 1]];
                    saveOfflineState();
                    renderApp();
                }
            }
            return;
        }

        const moveDownBtn = target.closest('.btn-move-down');
        if (moveDownBtn) {
            const player = moveDownBtn.getAttribute('data-player');
            if (player) {
                const idx = offlineState.players.indexOf(player);
                if (idx !== -1 && idx < offlineState.players.length - 1) {
                    [offlineState.players[idx + 1], offlineState.players[idx]] = [offlineState.players[idx], offlineState.players[idx + 1]];
                    saveOfflineState();
                    renderApp();
                }
            }
            return;
        }

        if (target.closest('#start-game-btn')) {
            startGameOffline();
            return;
        }
    } else {
        if (target.closest('#submit-bids-btn')) {
            submitBidsOffline();
            return;
        }
        if (target.closest('#submit-results-btn')) {
            submitRoundResultsOffline();
            return;
        }
        if (target.closest('#reset-game-btn')) {
            resetGameOffline();
            return;
        }
        if (target.closest('#undo-round-btn')) {
            undoRoundOffline();
            return;
        }
    }

    if (target.closest('#leave-game-btn')) {
        goBackToEntry();
    }
}

function handleAppKeyPress(e) {
    if (e.key !== 'Enter') return;

    if (currentMode !== 'offline') return;

    if (!offlineState.gameStarted && e.target.id === 'player-name') {
        e.preventDefault();
        addPlayerOffline();
        return;
    }

    if (!offlineState.gameStarted) return;

    const bidInput = e.target.closest('.bid-input');
    const trickInput = e.target.closest('.trick-input');

    if (bidInput && offlineState.bidPhase && !bidInput.disabled) {
        e.preventDefault();
        const allEnabledBidInputs = Array.from(app.querySelectorAll('.bid-input:not([disabled])'));
        const currentIndex = allEnabledBidInputs.findIndex(input => input === bidInput);
        const nextInput = allEnabledBidInputs[currentIndex + 1];

        if (nextInput) {
            nextInput.focus();
            nextInput.select();
        } else if (allBidsEntered(offlineState)) {
            submitBidsOffline();
        }
    } else if (trickInput && !offlineState.bidPhase) {
        e.preventDefault();
        const allTrickInputs = Array.from(app.querySelectorAll('.trick-input'));
        const currentIndex = allTrickInputs.findIndex(input => input === trickInput);
        const nextInput = allTrickInputs[currentIndex + 1];

        if (nextInput) {
            nextInput.focus();
            nextInput.select();
        } else if (allTricksEntered(offlineState) && validateTricksTotal(offlineState)) {
            submitRoundResultsOffline();
        }
    }
}

function handleAppInput(e) {
    if (currentMode !== 'offline') return;

    const target = e.target;
    const bidInput = target.closest('.bid-input');
    const trickInput = target.closest('.trick-input');

    if (bidInput && offlineState.gameStarted && offlineState.bidPhase) {
        const player = bidInput.getAttribute('data-player');
        const value = bidInput.value;
        if (player) handleBidChangeOffline(player, value);
    } else if (trickInput && offlineState.gameStarted && !offlineState.bidPhase) {
        const player = trickInput.getAttribute('data-player');
        const value = trickInput.value;
        if (player) handleTricksChangeOffline(player, value);
    }
}

function renderApp() {
    let newHtml = '';
    let currentState = {};

    if (currentMode === 'entry') {
        newHtml = renderEntryScreen();
    } else if (currentMode === 'offline') {
        currentState = offlineState;
        if (!currentState.gameStarted) newHtml = renderPlayerSetup(currentState);
        else newHtml = renderGameplay(currentState);
    } else {
        newHtml = '<div class="card"><p>Error: Invalid application state.</p></div>';
    }

    // Don't rerender if the HTML hasn't changed - prevents jitter
    if (newHtml === previousHtml) {
        return;
    }

    // More efficient DOM update strategy to minimize flicker
    // Create a temporary div to parse the HTML
    const tempContainer = document.createElement('div');
    tempContainer.innerHTML = newHtml;

    // Cache active element before DOM update
    const activeElement = document.activeElement;
    const activeId = activeElement ? activeElement.id : null;
    const activeDataPlayer = activeElement ? activeElement.getAttribute('data-player') : null;
    const activeSelectionStart = activeElement && 'selectionStart' in activeElement ? activeElement.selectionStart : null;
    const activeSelectionEnd = activeElement && 'selectionEnd' in activeElement ? activeElement.selectionEnd : null;

    // Update the DOM
    app.innerHTML = newHtml;
    previousHtml = newHtml;

    // Try to restore focus with selection if possible
    if (activeId) {
        const newActiveElement = document.getElementById(activeId);
        if (newActiveElement) {
            newActiveElement.focus();
            if (activeSelectionStart !== null && activeSelectionEnd !== null && 'selectionStart' in newActiveElement) {
                newActiveElement.selectionStart = activeSelectionStart;
                newActiveElement.selectionEnd = activeSelectionEnd;
            }
        }
    } else if (activeDataPlayer) {
        const newActiveElements = document.querySelectorAll(`[data-player="${activeDataPlayer}"]`);
        if (newActiveElements.length > 0) {
            newActiveElements[0].focus();
            if (activeSelectionStart !== null && activeSelectionEnd !== null && 'selectionStart' in newActiveElements[0]) {
                newActiveElements[0].selectionStart = activeSelectionStart;
                newActiveElements[0].selectionEnd = activeSelectionEnd;
            }
        }
    }

    applyPostRenderFocus(currentState);

    // Always update validation/buttons after render for the active offline game
    if (currentMode === 'offline') {
         updateValidationAndButtons();
         if (currentState.gameStarted && currentState.currentRound <= 14) {
            setTimeout(() => checkUpcomingElimination(currentState), 0);
         }
    }
}

function applyPostRenderFocus(currentState) {
    // Preserve the currently focused element
    const activeElementId = document.activeElement ? document.activeElement.id : '';
    const activeElementSelector = document.activeElement ? 
        (document.activeElement.getAttribute('data-player') ? 
            `.${document.activeElement.classList[0]}[data-player="${document.activeElement.getAttribute('data-player')}"]` : 
            '') : 
        '';
    const hadFocus = document.activeElement && 
        (document.activeElement.classList.contains('bid-input') || 
         document.activeElement.classList.contains('trick-input'));
    const selectionStart = hadFocus ? document.activeElement.selectionStart : null;
    const selectionEnd = hadFocus ? document.activeElement.selectionEnd : null;

    // Try to restore focus to the same element
    if (hadFocus && activeElementSelector) {
        const elementToFocus = document.querySelector(activeElementSelector);
        if (elementToFocus) {
            elementToFocus.focus();
            if (selectionStart !== null && selectionEnd !== null) {
                elementToFocus.selectionStart = selectionStart;
                elementToFocus.selectionEnd = selectionEnd;
            } else {
                elementToFocus.select();
            }
            return; // Exit early - we've restored focus
        }
    } else if (activeElementId) {
        const elementToFocus = document.getElementById(activeElementId);
        if (elementToFocus) {
            elementToFocus.focus();
            return; // Exit early - we've restored focus
        }
    }

    // Default focus behavior if we can't restore previous focus
    if (currentMode === 'entry') {
         const offlineBtn = document.getElementById('select-offline-btn');
         if (offlineBtn) offlineBtn.focus();
    } else if (currentMode === 'offline') {
         if (!currentState.gameStarted) {
            const playerNameInput = document.getElementById('player-name');
            if (playerNameInput) playerNameInput.focus();
         } else if (currentState.bidPhase && currentState.currentRound <= 14) {
            const firstInput = document.querySelector('.bid-input:not([disabled])'); // Focus first *enabled* bid input
            if (firstInput && (firstInput.value === '' || firstInput.value === null)) firstInput.focus();
         } else if (!currentState.bidPhase && currentState.currentRound <= 14) {
            const firstInput = document.querySelector('.trick-input');
            if (firstInput && (firstInput.value === '' || firstInput.value === null)) firstInput.focus();
         }
    }

    // Ensure back-to-menu button has a direct event listener as a fallback
    const backToMenuBtn = document.getElementById('back-to-menu-btn');
    if (backToMenuBtn) {
        // Remove any existing listeners to prevent duplicates
        backToMenuBtn.removeEventListener('click', goBackToEntry);
        // Add a fresh listener
        backToMenuBtn.addEventListener('click', goBackToEntry);
    }
}

function updateValidationAndButtons() {
    if (currentMode !== 'offline') return;

    const state = offlineState;
    if (!state || !state.gameStarted || state.currentRound > 14) return; // Only run if in a started game

    const totalBids = calculateTotalBids(state.bids, state.players);
    const totalTricks = calculateTotalTricks(state.tricks, state.players);
    const players = state.players || [];

    // --- Update Bid Info/Warning ---
    const bidInfoEl = document.getElementById('bid-info');
    if (bidInfoEl && state.bidPhase) {
        if (allPlayersHaveBid(state)) {
            if (totalBids === state.currentRound) {
                bidInfoEl.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Invalid: Total bids cannot equal ${state.currentRound} (currently ${totalBids}).`;
                bidInfoEl.className = 'game-info bid-warning';
            } else {
                bidInfoEl.innerHTML = `<i class="fas fa-check-circle"></i> Valid Bids: Total ${totalBids}`;
                bidInfoEl.className = 'game-info bid-ok';
            }
        } else {
            const waitingFor = players.filter(p => !state.bids || state.bids[p] === undefined || state.bids[p] === null);
            const waitingText = waitingFor.length > 0 ? ` Waiting for ${waitingFor.length > 2 ? waitingFor.length + ' players' : waitingFor.map(escapeHtml).join(' & ')}.` : '';
            bidInfoEl.innerHTML = `<i class="fas fa-info-circle"></i> Total bids: ${totalBids} / ${state.currentRound}.${waitingText}`;
            bidInfoEl.className = 'game-info';
        }
    }

    // --- Update Trick Info/Warning ---
    const trickInfoEl = document.getElementById('trick-info');
    if (trickInfoEl && !state.bidPhase) {
        if (allPlayersHaveTricks(state)) {
            if (totalTricks !== state.currentRound) {
                trickInfoEl.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Invalid: Total hands must equal ${state.currentRound} (currently ${totalTricks})`;
                trickInfoEl.className = 'game-info trick-warning';
            } else {
                trickInfoEl.innerHTML = `<i class="fas fa-check-circle"></i> Valid Hands: Total ${totalTricks}`;
                trickInfoEl.className = 'game-info trick-ok';
            }
        } else {
            const waitingFor = players.filter(p => !state.tricks || state.tricks[p] === undefined || state.tricks[p] === null);
            const waitingText = waitingFor.length > 0 ? ` Waiting for ${waitingFor.length > 2 ? waitingFor.length + ' players' : waitingFor.map(escapeHtml).join(' & ')}.` : '';
            trickInfoEl.innerHTML = `<i class="fas fa-info-circle"></i> Total hands: ${totalTricks} / ${state.currentRound}.${waitingText}`;
            trickInfoEl.className = 'game-info';
        }
    }

    // --- Update Button States ---
    const submitBidsBtn = document.getElementById('submit-bids-btn');
    if (submitBidsBtn) {
        submitBidsBtn.disabled = !allBidsEntered(state);
    }
    const submitResultsBtn = document.getElementById('submit-results-btn');
    if (submitResultsBtn) {
        submitResultsBtn.disabled = !(allTricksEntered(state) && validateTricksTotal(state));
    }
}

// --- Rendering Components ---

function renderEntryScreen() {
    // Check if there's a saved offline game
    const hasSavedGame = hasSavedOfflineGame();
    const offlineButtonText = hasSavedGame ? 
        `<i class="fas fa-undo"></i> Continue Offline Game` : 
        `<i class="fas fa-play"></i> Start Offline Game`;

    return `
        <div class="card mode-selection-container">
            <h2><i class="fas fa-dice"></i> Start a Game</h2>
            <div class="card">
                <h3><i class="fas fa-user-friends"></i> Play Offline</h3>
                <p>Play solo or pass the device around. Game progress is saved locally in your browser.</p>
                <button id="select-offline-btn" class="btn-full">${offlineButtonText}</button>
                <button id="handoff-import-btn" class="btn-small" style="margin-top:0.5rem;"><i class="fas fa-qrcode"></i> Import from QR</button>
            </div>
        </div>
    `;
}


function renderPlayerSetup(currentState) {
     const players = currentState.players || [];

     return `
        <div class="card">
          <h2><i class="fas fa-users-cog"></i> Player Setup</h2>

           <div class="input-group">
             <div class="input-with-button">
               <input type="text" id="player-name" placeholder="Enter player name" aria-label="Player name">
               <button class="btn-add" id="add-player-btn"><i class="fas fa-plus"></i> Add Player</button>
             </div>
           </div>

           ${players.length > 0 ? `
             <div>
               <h3><i class="fas fa-list-ul"></i> Current Players (${players.length})</h3>
               <div class="player-list">
                 ${players.map((player, idx) => `
  <div class="player-item">
    <span class="player-name">
      ${escapeHtml(player)}
      ${idx === 0 ? '<span class="dealer-badge"><i class="fas fa-crown"></i> Dealer</span>' : ''}
    </span>
    <div style="display: flex; gap: 0.25rem; align-items: center;">
      <button class="btn-move-up" data-player="${escapeHtml(player)}" ${idx === 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(player)} up" tabindex="0" title="Move up">
<i class="fas fa-arrow-up"></i>
      </button>
      <button class="btn-move-down" data-player="${escapeHtml(player)}" ${idx === players.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(player)} down" tabindex="0" title="Move down">
<i class="fas fa-arrow-down"></i>
      </button>
      <button class="btn-remove" data-player="${escapeHtml(player)}" aria-label="Remove ${escapeHtml(player)}">
<i class="fas fa-times"></i>
      </button>
    </div>
  </div>
`).join('')}
               </div>
             </div>
           ` : '<p style="text-align: center; color: var(--gray); font-size: 0.9rem; margin: 1.5rem 0;">No players added yet. Add 2 or more to start.</p>'}

           <button
             id="start-game-btn"
             class="btn-full btn-green"
             ${players.length < 2 ? 'disabled' : ''}
           >
             <i class="fas fa-play"></i>
             ${players.length < 2
               ? 'Need at least 2 players'
               : `Start Game (${players.length} Players)`}
           </button>
           <div class="button-group" style="margin-top: 1.5rem; justify-content: center;">
               <button id="back-to-menu-btn" class="btn-outline"><i class="fas fa-arrow-left"></i> Back to Start</button>
               <button id="handoff-import-btn" class="btn-small"><i class="fas fa-qrcode"></i> Import from QR</button>
           </div>
        </div>
     `;
}

function calculateRoundPoints(bid, tricks) {
    if (bid === undefined || bid === null || tricks === undefined || tricks === null) return null;
    const numericBid = Number(bid);
    const numericTricks = Number(tricks);
    if (!Number.isFinite(numericBid) || !Number.isFinite(numericTricks)) return null;
    if (numericBid !== numericTricks) return numericTricks;
    return numericBid === 0 ? 10 : numericTricks + (10 * numericBid);
}

function getRoundHistoryRows(roundEntry) {
    const entry = roundEntry && typeof roundEntry === 'object' ? roundEntry : {};
    const bids = entry.bids && typeof entry.bids === 'object' ? entry.bids : {};
    const tricks = entry.tricks && typeof entry.tricks === 'object' ? entry.tricks : {};
    const scoresBefore = entry.scores && typeof entry.scores === 'object' ? entry.scores : {};
    const players = Array.isArray(entry.players) && entry.players.length > 0
        ? entry.players
        : [...new Set([...Object.keys(bids), ...Object.keys(tricks), ...Object.keys(scoresBefore)])];

    return players.map(player => {
        const points = calculateRoundPoints(bids[player], tricks[player]);
        const scoreBefore = Number(scoresBefore[player]) || 0;
        return {
            player,
            bid: bids[player],
            tricks: tricks[player],
            points,
            totalScore: scoreBefore + (points === null ? 0 : points)
        };
    });
}

function renderRoundHistory(roundHistory, emptyMessage = 'No completed rounds yet.') {
    const rounds = Array.isArray(roundHistory) ? roundHistory : [];
    if (rounds.length === 0) {
        return `<p class="round-history-empty"><i class="fas fa-info-circle"></i> ${escapeHtml(emptyMessage)}</p>`;
    }

    return `<div class="round-history-list">
        ${rounds.map((roundEntry, index) => {
            const numericRound = Number(roundEntry && roundEntry.currentRound);
            const roundNumber = Number.isFinite(numericRound) ? Math.max(1, Math.trunc(numericRound)) : index + 1;
            const rows = getRoundHistoryRows(roundEntry);
            const totalBids = rows.reduce((total, row) => total + (Number(row.bid) || 0), 0);
            const dealerIndex = Number.isInteger(roundEntry && roundEntry.dealerIndex) ? roundEntry.dealerIndex : -1;
            const dealerName = dealerIndex >= 0 && Array.isArray(roundEntry.players) ? roundEntry.players[dealerIndex] : null;
            const openAttribute = index === rounds.length - 1 ? ' open' : '';
            return `
                <details class="round-history-item"${openAttribute}>
                    <summary>
                        <span class="round-history-summary">
                            <span><i class="fas fa-layer-group"></i> Round ${roundNumber}</span>
                            <span class="round-history-meta">${dealerName ? `Dealer: ${escapeHtml(dealerName)} · ` : ''}Total bids: ${totalBids}</span>
                        </span>
                    </summary>
                    <div class="table-container">
                        <table>
                            <thead><tr><th>Player</th><th>Bid</th><th>Won</th><th>Round</th><th>Total</th></tr></thead>
                            <tbody>
                                ${rows.map(row => `
                                    <tr>
                                        <td>${escapeHtml(row.player)}</td>
                                        <td>${row.bid === undefined || row.bid === null ? '-' : escapeHtml(row.bid)}</td>
                                        <td>${row.tricks === undefined || row.tricks === null ? '-' : escapeHtml(row.tricks)}</td>
                                        <td class="round-history-points">${row.points === null ? '-' : `+${row.points}`}</td>
                                        <td class="round-history-total">${row.totalScore}</td>
                                    </tr>
                                `).join('')}
                                ${rows.length === 0 ? '<tr><td colspan="5" style="text-align:center; color: var(--text-muted);">No player details saved for this round.</td></tr>' : ''}
                            </tbody>
                        </table>
                    </div>
                </details>
            `;
        }).join('')}
    </div>`;
}

function renderGameplay(currentState) {
    // Offline gameplay UI
    let gameplayHtml = '';
    const currentRound = currentState.currentRound || 1;
    const players = currentState.players || [];
    const eliminatedPlayers = currentState.eliminatedPlayers || [];
    const scores = currentState.scores || {};
    const bids = currentState.bids || {};
    const tricks = currentState.tricks || {};
    const bidPhase = currentState.bidPhase === undefined ? true : currentState.bidPhase;
    const dealerIndex = (Number.isInteger(currentState.dealerIndex) && players.length > 0)
        ? ((currentState.dealerIndex % players.length) + players.length) % players.length
        : 0;
    const dealerName = players.length > 0 ? players[dealerIndex] : null;
    let orderedPlayers = [...players];
    if (players.length > 1) {
        const startingIndex = (dealerIndex + 1) % players.length;
        orderedPlayers = [];
        for (let i = 0; i < players.length; i++) {
            orderedPlayers.push(players[(startingIndex + i) % players.length]);
        }
    }
    const startingBidder = orderedPlayers.length > 0 ? orderedPlayers[0] : null;
    const highlightLead = players.length > 1;

    // --- Round Input / Game Over ---
    if (currentRound <= 14) {
        const bidInfoHtml = bidPhase ? '<div id="bid-info" class="game-info"></div>' : '';
        const tricksInfoHtml = !bidPhase ? '<div id="trick-info" class="game-info"></div>' : '';
        gameplayHtml += `
        <div class="card">
            <div class="flex-between" style="margin-bottom: 0.25rem;">
            <h2><i class="fas fa-tasks"></i> Round ${currentRound} / 14</h2>
            <div style="display: flex; align-items: center; gap: 0.75rem;">
                <span class="game-status">${bidPhase ? 'Bidding Phase' : 'Enter Hands Won'}</span>
                <div id="round-elimination-banner" style="display: none; position: static;" class="elimination-banner">
                <i class="fas fa-exclamation-triangle"></i>
                <span id="round-elimination-message">Upcoming elimination</span>
                </div>
            </div>
            </div>

            ${bidPhase ? bidInfoHtml : tricksInfoHtml}

            <div class="table-container">
            <table>
                <thead>
                <tr>
                    <th>Player</th>
                    <th>Bid</th>
                    ${!bidPhase ? '<th>Hands Won</th>' : ''}
                    <th>Score</th>
                </tr>
                </thead>
                <tbody>
                ${orderedPlayers.map(player => {
                    const bidValue = bids[player] ?? '';
                    const trickValue = tricks[player] ?? '';
                    const isDealer = dealerName === player;
                    const isLeader = highlightLead && (startingBidder === player);
                    return `
                    <tr>
                    <td>
                        <span class="player-name">
                            ${escapeHtml(player)}
                            ${isDealer ? '<span class="dealer-badge"><i class="fas fa-crown"></i> Dealer</span>' : ''}
                            ${isLeader ? '<span class="lead-badge"><i class="fas fa-hand-point-right"></i> Leads</span>' : ''}
                        </span>
                    </td>
                    <td>
                        ${bidPhase
                        ? `<input type="number" min="0" max="${currentRound}" value="${escapeHtml(bidValue)}"
                            class="bid-input" data-player="${escapeHtml(player)}" aria-label="${escapeHtml(player)} bid"
                            inputmode="numeric" pattern="[0-9]*">`
                        : `<span class="badge badge-blue">${bidValue === '' || bidValue === null ? '?' : escapeHtml(bidValue)}</span>`}
                    </td>
                    ${!bidPhase
                        ? `<td class="trick-value">
                            <input type="number" min="0" max="14" value="${escapeHtml(trickValue)}"
                            class="trick-input" data-player="${escapeHtml(player)}" aria-label="${escapeHtml(player)} hands won"
                            inputmode="numeric" pattern="[0-9]*">
                        </td>`
                        : ''}
                    <td><span class="score-value">${escapeHtml(scores[player] || 0)}</span></td>
                    </tr>
                `}).join('')}
                ${eliminatedPlayers.map(player => `
                        <tr class="eliminated-player">
                        <td>${escapeHtml(player)} <i class="fas fa-user-slash"></i></td>
                        <td>${escapeHtml(bids[player] ?? '-')}</td>
                        ${!bidPhase ? `<td>${escapeHtml(tricks[player] ?? '-')}</td>` : ''}
                        <td>${escapeHtml(scores[player] || 0)}</td>
                        </tr>
                    `).join('')}
                 ${players.length === 0 && eliminatedPlayers.length === 0 ? '<tr><td colspan="4" style="text-align:center; color: var(--gray);">No players in game.</td></tr>' : ''}
                </tbody>
            </table>
            </div>

            ${bidPhase
            ? `<button id="submit-bids-btn" class="btn-full"><i class="fas fa-check-circle"></i> Confirm Bids</button>`
            : `<button id="submit-results-btn" class="btn-full btn-green"><i class="fas fa-flag-checkered"></i> Submit Round ${currentRound} Results</button>`
            }
        </div>
        `;
    } else { // Game Over
         const winners = getWinners(currentState);
         gameplayHtml += `
            <div class="card">
                <h2><i class="fas fa-trophy"></i> Game Over!</h2>
                ${winners.length > 0
                ? `<div class="winner-display">
                    <h3>${winners.length === 1 ? 'Winner' : 'Winners (Tie)'}</h3>
                    <div class="winner-name">
                        <i class="fas fa-crown"></i> ${winners.map(escapeHtml).join(' & ')}
                    </div>
                    <p>${escapeHtml(scores[winners[0]] || 0)} points</p>
                    </div>`
                : '<p style="text-align:center; color: var(--gray);">Could not determine winner.</p>'}

                <button id="reset-game-btn" class="btn-full btn-red">
                   <i class="fas fa-power-off"></i> Start New Game
                </button>
                 <button id="back-to-menu-btn" class="btn-full btn-outline" style="margin-top: 0.75rem;">
                    <i class="fas fa-arrow-left"></i> Back to Start
                </button>
            </div>
         `;
    }

    // --- Scoreboard ---
     const allPlayersForScoreboard = [...new Set([...(currentState.players || []), ...(currentState.eliminatedPlayers || [])])];
     const sortedPlayers = getSortedPlayers(scores, allPlayersForScoreboard);

    gameplayHtml += `
        <div class="card">
        <h2><i class="fas fa-clipboard-list"></i> Scoreboard</h2>
        <div class="table-container">
            <table>
            <thead><tr><th>Rank</th><th>Player</th><th>Score</th></tr></thead>
            <tbody>
                ${sortedPlayers.map((player, index) => {
                    const rank = index + 1;
                    const isEliminated = eliminatedPlayers.includes(player);
                    const isWinner = currentRound > 14 && getWinners(currentState).includes(player);
                    let medal = '';
                    if (isWinner && rank === 1) medal = '<i class="fas fa-medal" style="color: #d4af37;"></i>';
                    else if (currentRound > 14 && rank === 2) medal = '<i class="fas fa-medal" style="color: #c0c0c0;"></i>';
                    else if (currentRound > 14 && rank === 3) medal = '<i class="fas fa-medal" style="color: #cd7f32;"></i>';
                    return `
                <tr class="${isWinner ? 'winner-row' : ''} ${isEliminated ? 'eliminated-player' : ''}">
                    <td>${rank} ${medal}</td>
                    <td>${escapeHtml(player)} ${isEliminated ? '<i class="fas fa-user-slash" title="Eliminated"></i>' : ''}</td>
                    <td>${escapeHtml(scores[player] || 0)}</td>
                </tr>`;
                }).join('')}
                 ${sortedPlayers.length === 0 ? '<tr><td colspan="3" style="text-align:center; color: var(--gray);">No players on scoreboard yet.</td></tr>' : ''}
            </tbody>
            </table>
        </div>
        </div>

        <div class="card">
        <h2><i class="fas fa-history"></i> Round History</h2>
        ${renderRoundHistory(
            currentState.roundHistory,
            'Finish a round to see its bids, hands won, and scoring here.'
        )}
        </div>

        ${currentRound <= 14 ? `
            <div class="flex-between">
            <div class="button-group">
                 <button id="undo-round-btn" class="btn-outline"><i class="fas fa-undo-alt"></i> Undo Round</button>
                 <button id="leave-game-btn" class="btn-leave-game"><i class="fas fa-sign-out-alt"></i> Leave</button>
                 <button id="reset-game-btn" class="btn-red"><i class="fas fa-power-off"></i> Reset Game</button>
                 <button id="handoff-qr-btn" class="btn-small"><i class="fas fa-qrcode"></i> Hand-off via QR</button>
            </div>
            <p>Round ${currentRound} / 14</p>
            </div>
            ` : ''}
    `;

    return gameplayHtml;
}

function renderCompletedGames() {
    const entries = (localHistory || []).map((game, index) => ({ game, index }))
        .filter(entry => entry.game.mode === undefined || entry.game.mode === null || entry.game.mode === 'offline');

    if (entries.length === 0) {
        completedGamesList.innerHTML = '<div class="no-games"><i class="fas fa-folder-open"></i> No completed games yet</div>';
        return;
    }

    completedGamesList.innerHTML = entries.slice().reverse().map(({ game, index }) => {
        game.eliminatedPlayers = game.eliminatedPlayers || [];
        const allParticipants = [...new Set([...(game.players || []), ...game.eliminatedPlayers])];
        const elimCount = game.eliminatedPlayers.length ? `<span style="color: var(--danger)"><i class="fas fa-user-slash"></i> ${game.eliminatedPlayers.length}</span>` : '';
        return `<div class="completed-game-item" data-game-index="${index}">
                        <div><i class="fas fa-calendar-alt"></i> ${new Date(game.date).toLocaleDateString()} ${new Date(game.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
                        <div class="game-winner"><i class="fas fa-trophy"></i> ${game.winners.map(escapeHtml).join(' & ')}</div>
                        <div class="game-score"><i class="fas fa-star"></i> ${escapeHtml(game.score)} points</div>
                        <div style="font-size: 0.8rem;">
                        <i class="fas fa-users"></i> ${allParticipants.length} Players ${elimCount ? `(${elimCount} Eliminated)` : ''}
                        </div>
                    </div>`;
    }).join('');
}

// --- Offline Mode Logic ---

function getDefaultOfflineState() {
    return {
        players: [],
        gameStarted: false,
        currentRound: 1,
        dealerIndex: 0,
        bids: {},
        tricks: {},
        scores: {},
        bidPhase: true,
        roundHistory: [], // Specific to offline for undo
        eliminatedPlayers: []
    };
}

function loadOfflineState() {
    // Validate on every load: saves written by older versions may hold imported
    // data that was never checked.
    offlineState = sanitizeGameState(readStoredJSON(LOCAL_STORAGE_OFFLINE_KEY));
}

function saveOfflineState() {
    const json = JSON.stringify(offlineState);
    let result = writeStorage(LOCAL_STORAGE_OFFLINE_KEY, json);
    // When storage is full, make room from old games' round details rather
    // than silently losing the game in progress.
    while (!result.saved && result.full && dropOldestRoundDetails(localHistory.length) && persistHistory()) {
        result = writeStorage(LOCAL_STORAGE_OFFLINE_KEY, json);
    }
    return result.saved;
}

function addPlayerOffline() {
    const playerNameInput = document.getElementById('player-name');
    if (!playerNameInput) return;
    let playerName = playerNameInput.value.trim();
    if (playerName.length > 0) playerName = playerName.charAt(0).toUpperCase() + playerName.slice(1);

    if (playerName && !offlineState.players.includes(playerName)) {
        if (offlineState.players.length >= MAX_PLAYERS) { alert(`Maximum of ${MAX_PLAYERS} players allowed.`); return; }
        offlineState.players.push(playerName);
        if (offlineState.players.length === 1) {
            offlineState.dealerIndex = 0;
        }
        offlineState.scores[playerName] = 0; // Initialize score
        playerNameInput.value = '';
        saveOfflineState();
        renderApp();
    } else if (offlineState.players.includes(playerName)) {
        alert(`Player "${escapeHtml(playerName)}" already exists!`);
        playerNameInput.select();
    } else {
        playerNameInput.focus();
    }
}

function removePlayerOffline(playerToRemove) {
    offlineState.players = offlineState.players.filter(p => p !== playerToRemove);
    delete offlineState.scores[playerToRemove];
    delete offlineState.bids[playerToRemove];
    delete offlineState.tricks[playerToRemove];
    const remainingPlayers = offlineState.players.length;
    if (remainingPlayers === 0) {
        offlineState.dealerIndex = 0;
    } else if (offlineState.dealerIndex >= remainingPlayers) {
        offlineState.dealerIndex = remainingPlayers - 1;
    }
    // Clear from history if needed? Maybe not for offline.
    saveOfflineState();
    renderApp();
}

function startGameOffline() {
    if (offlineState.players.length < 2) { alert("Need at least 2 players."); return; }
    offlineState.gameStarted = true;
    offlineState.currentRound = 1;
    offlineState.dealerIndex = 0;
    offlineState.bidPhase = true;
    offlineState.bids = {};
    offlineState.tricks = {};
    offlineState.eliminatedPlayers = [];
    offlineState.roundHistory = []; // Reset history
    offlineState.players.forEach(p => { offlineState.scores[p] = 0; });
    trackAnalyticsEvent('game_started', {
        player_count: offlineState.players.length
    });
    saveOfflineState();
    renderApp();
    checkUpcomingElimination(offlineState);
}

 function handleBidChangeOffline(player, value) {
    const maxBid = offlineState.currentRound;
    const bidValue = value === '' ? undefined : Math.min(Math.max(0, parseInt(value) || 0), maxBid);
    offlineState.bids[player] = bidValue;
    saveOfflineState();
    updateValidationAndButtons(); // Faster UI feedback without full re-render
 }

 function handleTricksChangeOffline(player, value) {
    const tricksValue = value === '' ? undefined : Math.min(Math.max(0, parseInt(value) || 0), 14);
    offlineState.tricks[player] = tricksValue;
    saveOfflineState();
    updateValidationAndButtons();
 }

 function submitBidsOffline() {
     if (!allBidsEntered(offlineState)) {
         alert("Please ensure all players have entered a valid bid, and the total bids do not equal the current round number."); return;
     }
     offlineState.bidPhase = false;
     offlineState.tricks = {}; // Clear tricks for this phase
     offlineState.players.forEach(p => offlineState.tricks[p] = undefined); // Explicitly undefined
     saveOfflineState();
     renderApp();
 }

 function submitRoundResultsOffline() {
    if (!allTricksEntered(offlineState) || !validateTricksTotal(offlineState)) {
        alert("Please enter hands won for all players, and ensure the total equals the current round number."); return;
    }

    const completedRoundNumber = offlineState.currentRound;

    // Save current state for undo
    offlineState.roundHistory.push(JSON.parse(JSON.stringify({
        currentRound: offlineState.currentRound,
        bids: offlineState.bids,
        tricks: offlineState.tricks,
        scores: offlineState.scores,
        bidPhase: offlineState.bidPhase,
        eliminatedPlayers: [...offlineState.eliminatedPlayers],
        players: [...offlineState.players],
        dealerIndex: offlineState.dealerIndex
     })));

    const activePlayersBefore = [...offlineState.players];
    const totalBefore = activePlayersBefore.length;
    const dealerIndexBefore = (totalBefore > 0 && Number.isInteger(offlineState.dealerIndex))
        ? ((offlineState.dealerIndex % totalBefore) + totalBefore) % totalBefore
        : 0;
    const currentDealerName = totalBefore > 0 ? activePlayersBefore[dealerIndexBefore] : null;
    const dealerRotationCandidates = [];
    if (totalBefore > 1) {
        for (let offset = 1; offset < totalBefore; offset++) {
            dealerRotationCandidates.push(activePlayersBefore[(dealerIndexBefore + offset) % totalBefore]);
        }
    }

     // Calculate scores
     let newEliminatedPlayers = [];
     offlineState.players.forEach(player => {
         const bid = offlineState.bids[player];
         const tricks = offlineState.tricks[player];
         if (typeof bid === 'number' && typeof tricks === 'number') {
             let roundScore = (bid === tricks) ? (bid === 0 ? 10 : tricks + (10 * bid)) : tricks;
             offlineState.scores[player] = (offlineState.scores[player] || 0) + roundScore;
         }
     });

     if (offlineState.currentRound < 14) {
         offlineState.currentRound++;
         offlineState.bidPhase = true;

         newEliminatedPlayers = checkElimination(offlineState); // Check for elimination
         if (newEliminatedPlayers.length > 0) {
             const eliminatedSet = new Set(newEliminatedPlayers);
             offlineState.eliminatedPlayers.push(...newEliminatedPlayers);
             offlineState.players = offlineState.players.filter(p => !eliminatedSet.has(p));
         }
         const playersAfterElimination = offlineState.players;

         offlineState.bids = {}; // Reset bids/tricks for next round
         offlineState.tricks = {};
         playersAfterElimination.forEach(p => { offlineState.bids[p] = undefined; offlineState.tricks[p] = undefined; });

         if (playersAfterElimination.length > 0) {
             let nextDealerName = null;
             for (const candidate of dealerRotationCandidates) {
                 if (playersAfterElimination.includes(candidate)) {
                     nextDealerName = candidate;
                     break;
                 }
             }
             if (!nextDealerName) {
                 if (currentDealerName && playersAfterElimination.includes(currentDealerName)) {
                     nextDealerName = currentDealerName;
                 } else {
                     nextDealerName = playersAfterElimination[0];
                 }
             }
             const newIndex = playersAfterElimination.indexOf(nextDealerName);
             offlineState.dealerIndex = newIndex === -1 ? 0 : newIndex;
         } else {
             offlineState.dealerIndex = 0;
         }

         checkUpcomingElimination(offlineState);

     } else {
         offlineState.currentRound = 15; // Game over
         saveCompletedGameToLocal(offlineState);
     }

     trackAnalyticsEvent('round_recorded', {
         round_number: completedRoundNumber,
         player_count: totalBefore,
         eliminated_count: newEliminatedPlayers.length
     });

     if (completedRoundNumber === 14) {
         const participantCount = new Set([
             ...(offlineState.players || []),
             ...(offlineState.eliminatedPlayers || [])
         ]).size;
         trackAnalyticsEvent('game_completed', {
             player_count: participantCount,
             round_count: offlineState.roundHistory.length,
             winner_count: getWinners(offlineState).length
         });
     }

     saveOfflineState(); // Save potentially modified state (elimination, next round)
     renderApp();
 }

function resetGameOffline() {
    if (confirm("Are you sure you want to start a new offline game? This will clear the current offline game progress.")) {
        trackAnalyticsEvent('game_reset', {
            player_count: Array.isArray(offlineState.players) ? offlineState.players.length : 0,
            round_number: offlineState.currentRound || 1
        });
        offlineState = getDefaultOfflineState();
        saveOfflineState();
        previousHtml = ''; // Force re-render
        renderApp();
        hideEliminationBanner();
    }
}

function undoRoundOffline() {
     if (offlineState.roundHistory && offlineState.roundHistory.length > 0) {
        if (confirm("Are you sure you want to undo the last round?")) {
            const prevState = offlineState.roundHistory.pop();
            trackAnalyticsEvent('round_undone', {
                player_count: Array.isArray(prevState.players) ? prevState.players.length : 0,
                round_number: prevState.currentRound
            });

            // Restore previous state values
            offlineState.currentRound = prevState.currentRound;
            offlineState.bids = prevState.bids;
            offlineState.scores = prevState.scores;
            offlineState.eliminatedPlayers = prevState.eliminatedPlayers; // Restore eliminated list

            // Restore active players list based on who had scores in the previous state
            // and remove players who were only eliminated *after* that round
            const previousActivePlayers = Array.isArray(prevState.players)
                ? prevState.players
                : Object.keys(prevState.scores).filter(p => !prevState.eliminatedPlayers.includes(p));
            offlineState.players = [...previousActivePlayers];

            if (Number.isInteger(prevState.dealerIndex)) {
                const count = offlineState.players.length;
                offlineState.dealerIndex = count > 0
                    ? ((prevState.dealerIndex % count) + count) % count
                    : 0;
            } else {
                offlineState.dealerIndex = 0;
            }


            offlineState.bidPhase = true; // Always go back to bidding phase
            offlineState.tricks = {}; // Clear tricks for the restored round
             offlineState.players.forEach(p => offlineState.tricks[p] = undefined);

            saveOfflineState();
            renderApp();
            checkUpcomingElimination(offlineState); // Recheck eliminations
        }
     } else {
         alert("No rounds to undo.");
     }
}

// --- Shared Helper & Validation Functions ---

function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
         .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function applyTheme(theme) {
    const newTheme = (theme === 'dark') ? 'dark' : 'light';
    body.setAttribute('data-theme', newTheme);
    darkModeToggle.checked = newTheme === 'dark';
    writeStorage(LOCAL_STORAGE_THEME_KEY, newTheme);
    console.log("Theme applied:", newTheme);
}

function calculateTotalBids(bids, players) {
    return (players || []).reduce((sum, p) => {
        const bid = bids && bids[p];
        return sum + (bid === null || bid === undefined ? 0 : Number(bid) || 0);
    }, 0);
}

function calculateTotalTricks(tricks, players) {
    return (players || []).reduce((sum, p) => {
        const trick = tricks && tricks[p];
        return sum + (trick === null || trick === undefined ? 0 : Number(trick) || 0);
    }, 0);
}

function allPlayersHaveBid(currentState) {
    const players = currentState.players || [];
    if (players.length === 0) return false;
    return players.every(p => currentState.bids && currentState.bids[p] !== undefined && currentState.bids[p] !== null);
}

function allPlayersHaveTricks(currentState) {
     const players = currentState.players || [];
     if (players.length === 0) return false;
     return players.every(p => currentState.tricks && currentState.tricks[p] !== undefined && currentState.tricks[p] !== null);
}

function allBidsEntered(currentState) {
    const players = currentState.players || [];
    if (!currentState.gameStarted || !currentState.bidPhase || players.length === 0) return false;
    if (!allPlayersHaveBid(currentState)) return false;
    const totalBids = calculateTotalBids(currentState.bids, players);
    return totalBids !== currentState.currentRound;
}

function allTricksEntered(currentState) {
    const players = currentState.players || [];
    if (!currentState.gameStarted || currentState.bidPhase || players.length === 0) return false;
    return allPlayersHaveTricks(currentState);
}

function validateTricksTotal(currentState) {
    const players = currentState.players || [];
    if (!currentState.gameStarted || currentState.bidPhase || players.length === 0) return false;
    const totalTricks = calculateTotalTricks(currentState.tricks, players);
    return totalTricks === currentState.currentRound;
}

function getWinners(currentState) {
     if (!currentState || !currentState.gameStarted || currentState.currentRound <= 14) return [];
     const scores = currentState.scores || {};
     if (Object.keys(scores).length === 0) return [];

     const finalPlayers = [...new Set([...(currentState.players || []), ...(currentState.eliminatedPlayers || [])])];
     if (finalPlayers.length === 0) return [];

     let highestScore = -Infinity;
     finalPlayers.forEach(player => { highestScore = Math.max(highestScore, scores[player] || 0); });
     if (highestScore === -Infinity) return [];

     return finalPlayers.filter(player => (scores[player] || 0) === highestScore);
}

function getSortedPlayers(scores, playerList) {
     if (!playerList || playerList.length === 0) return [];
     const scoresObj = scores || {};
     return [...playerList]
        .map(player => ({ name: player, score: scoresObj[player] || 0 }))
        .sort((a, b) => b.score - a.score)
        .map(p => p.name);
}

function getMaxPlayersForRound(round) {
    const numericRound = Number(round);
    const normalizedRound = Number.isFinite(numericRound) && numericRound > 0 ? numericRound : 1;
    return Math.max(1, Math.floor(ELIMINATION_THRESHOLD / normalizedRound));
}

function calculateEliminationPlan(currentState) {
     const players = Array.isArray(currentState && currentState.players) ? currentState.players : [];
     const scores = currentState && currentState.scores ? currentState.scores : {};
     const numericRound = Number(currentState && currentState.currentRound);
     const currentRound = Number.isFinite(numericRound) && numericRound > 0 ? numericRound : 1;
     const maxPlayers = getMaxPlayersForRound(currentRound);
     const excessPlayers = Math.max(0, players.length - maxPlayers);
     const eliminateCount = Math.min(excessPlayers, Math.max(0, players.length - 1));

     if (eliminateCount === 0) {
        return { round: currentRound, maxPlayers, count: 0, players: [] };
     }

     const playersToEliminate = players
        .map((player, index) => ({
            player,
            index,
            score: Number(scores[player]) || 0
        }))
        .sort((a, b) => (a.score - b.score) || (a.index - b.index))
        .slice(0, eliminateCount)
        .map(entry => entry.player);

     return {
        round: currentRound,
        maxPlayers,
        count: playersToEliminate.length,
        players: playersToEliminate
     };
}

function getUpcomingEliminationPlan(currentState) {
    if (!currentState || !currentState.gameStarted || currentState.currentRound > 14 || !Array.isArray(currentState.players) || currentState.players.length < 2) {
        return null;
    }

    for (let futureRound = currentState.currentRound; futureRound <= 14; futureRound++) {
        const futurePlan = calculateEliminationPlan({ ...currentState, currentRound: futureRound });
        if (futurePlan.count > 0) return futurePlan;
    }

    return null;
}

function formatEliminatedPlayerSummary(players) {
    const visiblePlayers = players.slice(0, 12).join(', ');
    return players.length > 12 ? `${visiblePlayers}, and ${players.length - 12} more` : visiblePlayers;
}

function checkElimination(currentState) {
     const plan = calculateEliminationPlan(currentState);

     if (plan.count > 0) {
        const plural = plan.count === 1 ? 'player' : 'players';
        const names = formatEliminatedPlayerSummary(plan.players);
        alert(`${plan.count} ${plural} eliminated for Round ${plan.round} (maximum ${plan.maxPlayers} active players): ${names}`);
     }

     return plan.players;
}

function checkUpcomingElimination(currentState) {
    const upcomingPlan = getUpcomingEliminationPlan(currentState);

    if (upcomingPlan) {
        showEliminationBanner(upcomingPlan);
    } else {
        hideEliminationBanner();
    }
}

function showEliminationBanner(elimination) {
    const plan = typeof elimination === 'number'
        ? { round: elimination, count: 1 }
        : elimination;
    const count = plan && plan.count ? plan.count : 1;
    const plural = count === 1 ? 'elimination' : 'eliminations';
    const roundMessage = document.getElementById('round-elimination-message');
    const roundBanner = document.getElementById('round-elimination-banner');
    if (roundMessage && roundBanner) {
        roundMessage.textContent = `${count} ${plural} at Round ${plan.round}`;
        // Always keep the element in DOM but control visibility with opacity
        if (roundBanner.style.display === 'none') {
            roundBanner.style.display = 'flex';
        }
    }
    // Keep fixed banner hidden
    const origBanner = document.getElementById('elimination-banner');
    if (origBanner) origBanner.style.display = 'none';
}

function hideEliminationBanner() {
    const origBanner = document.getElementById('elimination-banner');
    if (origBanner) origBanner.style.display = 'none';

    const roundBanner = document.getElementById('round-elimination-banner');
    if (roundBanner) roundBanner.style.display = 'none';
}

function copyGameIdToClipboard(gameId, displayElement) {
     if (!navigator.clipboard) { alert("Clipboard not available."); return; }
     navigator.clipboard.writeText(gameId).then(() => {
         const feedbackEl = displayElement.querySelector('.copy-feedback');
         if (feedbackEl) {
             feedbackEl.classList.add('visible');
             setTimeout(() => feedbackEl.classList.remove('visible'), 1500);
         }
     }).catch(err => { console.error('Failed to copy:', err); alert('Copy failed.'); });
}

function showQRCode(gameId) {
    const qrCodeModal = document.getElementById('qr-code-modal');
    const qrCodeContainer = document.getElementById('qr-code-container');
    const qrCodeClose = document.getElementById('qr-code-close');

    // Clear previous QR code
    qrCodeContainer.innerHTML = '';

    // Generate a QR code with just the game ID as plain text
    // This will allow the user to easily copy it after scanning
    const qrData = gameId;

    try {
        // Generate QR code with qrcodejs
        new QRCode(qrCodeContainer, {
            text: qrData,
            width: 250,
            height: 250,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.H
        });

        // Add game ID display and copy button below QR code
        const infoContainer = document.createElement('div');
        infoContainer.style.marginTop = '1rem';
        infoContainer.style.textAlign = 'center';

        // Game ID display
        const gameIdDisplay = document.createElement('div');
        gameIdDisplay.style.fontFamily = 'monospace';
        gameIdDisplay.style.padding = '0.5rem';
        gameIdDisplay.style.backgroundColor = 'var(--light-alt)';
        gameIdDisplay.style.border = '1px solid var(--gray-light)';
        gameIdDisplay.style.borderRadius = 'var(--radius)';
        gameIdDisplay.style.marginBottom = '0.5rem';
        gameIdDisplay.style.wordBreak = 'break-all';
        gameIdDisplay.textContent = gameId;

        // Copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn-small';
        copyBtn.innerHTML = '<i class="far fa-copy"></i> Copy Game ID';
        copyBtn.style.margin = '0 auto';

        // Feedback element
        const feedbackEl = document.createElement('span');
        feedbackEl.className = 'copy-feedback';
        feedbackEl.id = `qr-copy-feedback-${gameId}`;
        feedbackEl.textContent = 'Copied!';
        feedbackEl.style.display = 'block';
        feedbackEl.style.marginTop = '0.5rem';

        // Add click handler for copy button
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(gameId).then(() => {
                feedbackEl.classList.add('visible');
                setTimeout(() => feedbackEl.classList.remove('visible'), 1500);
            }).catch(err => {
                console.error('Failed to copy:', err);
                alert('Copy failed.');
            });
        });

        // Append elements
        infoContainer.appendChild(gameIdDisplay);
        infoContainer.appendChild(copyBtn);
        infoContainer.appendChild(feedbackEl);
        qrCodeContainer.appendChild(infoContainer);

        // Update instructions
        const instructionsDiv = document.querySelector('.qr-code-instructions');
        if (instructionsDiv) {
            instructionsDiv.innerHTML = `
                Scan this QR code with your phone's camera or QR scanner app,<br>
                or copy the game ID manually to join the game.
            `;
        }
    } catch (err) {
        console.error('Failed to generate QR code:', err);
        qrCodeContainer.innerHTML = '<p>QR code generation failed. Please try again.</p>';
    }

    // Show modal
    qrCodeModal.classList.add('active');

    // Add close handler
    qrCodeClose.onclick = function() {
        qrCodeModal.classList.remove('active');
    };

    // Close on background click
    qrCodeModal.onclick = function(e) {
        if (e.target === qrCodeModal) {
            qrCodeModal.classList.remove('active');
        }
    };
}

// --- Local History Management ---
function readStoredHistory() {
    const stored = readStoredJSON(LOCAL_STORAGE_HISTORY_KEY);
    return Array.isArray(stored) ? stored.map(sanitizeCompletedGame).filter(Boolean) : null;
}

function loadLocalHistory() {
    localHistory = readStoredHistory() || [];
    renderCompletedGames();
}

// Removes the round-by-round details of the oldest game that still has them
// (its summary stays). Used only when storage is full.
function dropOldestRoundDetails(limit) {
    for (let i = 0; i < Math.min(limit, localHistory.length); i++) {
        const game = localHistory[i];
        if (game && Array.isArray(game.roundHistory) && game.roundHistory.length > 0) {
            delete game.roundHistory;
            return true;
        }
    }
    return false;
}

function persistHistory() {
    let result = writeStorage(LOCAL_STORAGE_HISTORY_KEY, JSON.stringify(localHistory));
    // Keep the newest game's details; trim older ones until the history fits.
    while (!result.saved && result.full && dropOldestRoundDetails(localHistory.length - 1)) {
        result = writeStorage(LOCAL_STORAGE_HISTORY_KEY, JSON.stringify(localHistory));
    }
    return result.saved;
}

function saveCompletedGameToLocal(finalState) {
    const winners = getWinners(finalState);
    const completedGame = {
        mode: 'offline',
        gameId: null,
        date: new Date().toISOString(),
        winners: winners,
        score: winners.length > 0 ? (finalState.scores[winners[0]] || 0) : 0,
        players: [...(finalState.players || [])], // Active players at end
        finalScores: { ...(finalState.scores || {}) },
        eliminatedPlayers: [...(finalState.eliminatedPlayers || [])],
        roundHistory: JSON.parse(JSON.stringify(finalState.roundHistory || [])),
        wasReset: finalState.wasReset || false // Include reset flag if it exists
    };
    // Re-read so games finished in another tab are kept.
    localHistory = readStoredHistory() || localHistory;
    localHistory.push(completedGame);
    persistHistory();
    renderCompletedGames();
}

function showGameDetails(gameIndex) {
    const game = localHistory[gameIndex];
    if (!game) return;
    const gameDate = new Date(game.date);
    const formattedDate = `${gameDate.toLocaleDateString()} ${gameDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    game.eliminatedPlayers = game.eliminatedPlayers || [];
    const allParticipants = [...new Set([...(game.players || []), ...game.eliminatedPlayers])];
    const sortedPlayers = getSortedPlayers(game.finalScores || {}, allParticipants);

    let content = `
        <div class="game-date"><i class="fas fa-calendar-alt"></i> ${formattedDate}</div>
        <div class="game-details-winners">
        <h4>${game.winners.length === 1 ? 'Winner' : 'Winners (Tie)'}</h4>
        <div class="winner-names">
            <i class="fas fa-crown"></i> ${game.winners.map(escapeHtml).join(' & ')}
            <span style="margin-left:auto;">${escapeHtml(game.score)} points</span>
        </div>
        </div>
        <h4>All Players (${allParticipants.length})</h4>
        <div class="player-scores-container">
        <div class="player-scores-header"><span>Player</span><span>Final Score</span></div>
        <div class="player-scores-list">
    `;
    sortedPlayers.forEach((player, index) => {
        const isWinner = game.winners.includes(player);
        const isEliminated = game.eliminatedPlayers.includes(player);
        const playerScore = game.finalScores[player] || 0;
        content += `
        <div class="player-score-item ${isWinner ? 'winner' : ''} ${isEliminated ? 'eliminated' : ''}">
            <span class="player-score-name">${index + 1}. ${escapeHtml(player)} ${isEliminated ? '<i class="fas fa-user-slash" title="Eliminated"></i>' : ''}</span>
            <span class="player-score-value">${escapeHtml(playerScore)}</span>
        </div>`;
    });
    content += `</div></div>
        <div style="margin-top: 1.5rem;">
            <h4><i class="fas fa-history"></i> Round History</h4>
            ${renderRoundHistory(
                game.roundHistory,
                'Round-by-round details were not saved for this older game.'
            )}
        </div>`;
    gameDetailsBody.innerHTML = content;
    gameDetailsModal.classList.add('active');
}

function closeGameDetailsModal() {
     gameDetailsModal.classList.remove('active');
     gameDetailsBody.innerHTML = ''; // Clear content
}

// --- Service Worker ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js') // Ensure service-worker.js exists
        .then(reg => console.log('Service Worker registered:', reg.scope))
        .catch(err => console.error('Service Worker registration failed:', err));
    });
     navigator.serviceWorker.addEventListener('controllerchange', () => {
         console.log('Service Worker updated.');
         // Optional: Add prompt to reload window.location.reload();
     });

     // Add to Home Screen logic (optional but good for PWA)
    let deferredPrompt;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        console.log("`beforeinstallprompt` event was fired.");
        // Optionally, show a custom install button here
    });
     window.addEventListener('appinstalled', () => {
         console.log('PWA was installed');
         deferredPrompt = null;
    });
}

// --- Start the App ---
initializeApp();

// --- Hand-off QR Export/Import Logic ---
function showHandoffImportNotice(message, type = 'success') {
    if (!handoffImportBanner) return;
    const icon = type === 'error' ? 'fa-exclamation-circle' : 'fa-check-circle';
    handoffImportBanner.className = `handoff-import-banner active ${type}`;
    handoffImportBanner.innerHTML = `<i class="fas ${icon}"></i><span>${escapeHtml(message)}</span>`;
    window.setTimeout(() => {
        handoffImportBanner.classList.remove('active');
    }, 6000);
}

function setHandoffStatus(statusEl, message, type = 'info') {
    if (!statusEl) return;
    statusEl.textContent = message;
    if (type === 'success') {
        statusEl.style.color = 'var(--success)';
    } else if (type === 'error') {
        statusEl.style.color = 'var(--danger)';
    } else {
        statusEl.style.color = 'var(--gray)';
    }
}

function getMinimalHandoffState(fullState) {
    return {
        players: fullState.players || [],
        gameStarted: fullState.gameStarted || false,
        currentRound: fullState.currentRound || 1,
        dealerIndex: Number.isInteger(fullState.dealerIndex) ? fullState.dealerIndex : 0,
        bids: fullState.bids || {},
        tricks: fullState.tricks || {},
        scores: fullState.scores || {},
        bidPhase: fullState.bidPhase !== false,
        eliminatedPlayers: fullState.eliminatedPlayers || [],
        roundHistory: Array.isArray(fullState.roundHistory) ? fullState.roundHistory : []
    };
}

function buildHandoffImportUrl(compressed) {
    const baseUrl = window.location.origin + window.location.pathname;
    return `${baseUrl}?import=${compressed}`;
}

function isLocalHandoffUrl(urlText) {
    try {
        const url = new URL(urlText);
        return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    } catch (err) {
        return false;
    }
}

function buildHandoffPayload(fullState) {
    const minimalState = getMinimalHandoffState(fullState);
    const minimalStateStr = JSON.stringify(minimalState);
    const compressed = LZString.compressToEncodedURIComponent(minimalStateStr);
    const importUrl = buildHandoffImportUrl(compressed);
    const rawPayload = HANDOFF_COMPRESSED_PREFIX + compressed;

    return {
        minimalState,
        compressed,
        importUrl,
        rawPayload,
        importUrlSize: new Blob([importUrl]).size,
        rawPayloadSize: new Blob([rawPayload]).size
    };
}

function copyHandoffText(text, statusEl, label = 'Copied') {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
        setHandoffStatus(statusEl, 'Clipboard not available. Select and copy the text manually.', 'error');
        return;
    }

    navigator.clipboard.writeText(text).then(() => {
        setHandoffStatus(statusEl, `${label} to clipboard.`, 'success');
    }).catch(err => {
        console.error('Copy failed:', err);
        setHandoffStatus(statusEl, 'Copy failed. Select and copy the text manually.', 'error');
    });
}

// Keep each symbol small enough to resolve on a phone screen. The checksum
// groups frames from the same snapshot and detects incomplete/mixed data.
function handoffChecksum(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildHandoffQRFrames(rawPayload) {
    if (rawPayload.length <= 550) return [rawPayload];
    const count = Math.ceil(rawPayload.length / 500);
    if (count > 128) return [];
    const id = handoffChecksum(rawPayload);
    return Array.from({ length: count }, (_, index) =>
        `14HIGHQ:1:${id}:${index + 1}:${count}:${rawPayload.slice(index * 500, (index + 1) * 500)}`);
}

function collectHandoffQRFrame(text, transfer) {
    if (!text.startsWith('14HIGHQ:')) return { payload: text };
    const match = /^14HIGHQ:1:([a-f0-9]{8}):(\d+):(\d+):([\s\S]+)$/.exec(text);
    if (!match) throw new Error('Invalid game QR part.');
    const [, id, indexText, countText, chunk] = match;
    const index = Number(indexText);
    const count = Number(countText);
    if (count < 2 || count > 128 || index < 1 || index > count || chunk.length > 500) {
        throw new Error('Invalid game QR part.');
    }
    if (transfer.id !== id || transfer.count !== count) {
        transfer.id = id;
        transfer.count = count;
        transfer.parts = new Map();
    }
    transfer.parts.set(index, chunk);
    if (transfer.parts.size !== count) return { received: transfer.parts.size, count };
    const payload = Array.from({ length: count }, (_, i) => transfer.parts.get(i + 1)).join('');
    if (handoffChecksum(payload) !== id) {
        transfer.parts.clear();
        throw new Error('Could not combine game QR parts. Keep scanning to try again.');
    }
    return { payload, received: count, count };
}

function renderHandoffQRCode(container, text) {
    // qrcodejs does not draw a quiet zone. Render its matrix at whole-pixel
    // module sizes with the required four-module white border on every side.
    const scratch = document.createElement('div');
    const qr = new QRCode(scratch, { text, width: 256, height: 256,
        correctLevel: QRCode.CorrectLevel.M });
    const matrix = qr._oQRCode;
    const count = matrix.getModuleCount();
    const scale = 4;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = (count + 8) * scale;
    canvas.className = 'handoff-qr-image';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Game transfer QR code');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (matrix.isDark(row, col)) ctx.fillRect((col + 4) * scale, (row + 4) * scale, scale, scale);
        }
    }
    container.replaceChildren(canvas);
}

function showHandoffQRModal() {
    const modal = document.getElementById('handoff-qr-modal');
    const container = document.getElementById('handoff-qr-container');
    const closeBtn = document.getElementById('handoff-qr-close');
    if (!modal || !container) return;
    container.innerHTML = '';
    let frameTimer;
    const close = () => {
        window.clearInterval(frameTimer);
        modal.classList.remove('active');
    };
    closeBtn.onclick = close;
    modal.onclick = e => { if (e.target === modal) close(); };

    // Get offline game state
    let stateStr = localStorage.getItem(LOCAL_STORAGE_OFFLINE_KEY);
    if (!stateStr) {
        container.innerHTML = '<p style="color:var(--danger);">No offline game to export.</p>';
        modal.classList.add('active');
        return;
    }

    try {
        // Parse and compress the game state for QR export
        const fullState = JSON.parse(stateStr);
        const handoff = buildHandoffPayload(fullState);
        JSON.parse(LZString.decompressFromEncodedURIComponent(handoff.compressed));
        const frames = buildHandoffQRFrames(handoff.rawPayload);
        const qrAvailable = frames.length > 0;
        trackAnalyticsEvent('handoff_export_opened', {
            transfer_method: qrAvailable ? 'qr' : 'copy_data',
            qr_available: qrAvailable,
            player_count: Array.isArray(fullState.players) ? fullState.players.length : 0,
            round_number: fullState.currentRound || 1
        });

        const statusEl = document.createElement('div');
        statusEl.style.fontSize = '0.88rem';
        statusEl.setAttribute('role', 'status');
        if (qrAvailable) {
            const imageContainer = document.createElement('div');
            imageContainer.style.width = '100%';
            container.appendChild(imageContainer);
            let frameIndex = 0;
            const drawFrame = () => {
                renderHandoffQRCode(imageContainer, frames[frameIndex]);
                setHandoffStatus(statusEl, frames.length === 1
                    ? 'Ready to scan using Import from QR in 14-High.'
                    : `Code ${frameIndex + 1} of ${frames.length} — keep scanning until the game opens.`);
                frameIndex = (frameIndex + 1) % frames.length;
            };
            drawFrame();
            if (frames.length > 1) frameTimer = window.setInterval(drawFrame, 1800);
        } else {
            setHandoffStatus(statusEl, 'This game is too large for QR. Use Copy Import Data to transfer the complete game.', 'error');
        }
        container.appendChild(statusEl);

        const actions = document.createElement('div');
        actions.className = 'handoff-actions';

        const copyLinkBtn = document.createElement('button');
        copyLinkBtn.type = 'button';
        copyLinkBtn.className = 'btn-small';
        copyLinkBtn.innerHTML = '<i class="fas fa-link"></i> Copy Link';
        copyLinkBtn.addEventListener('click', () => copyHandoffText(handoff.importUrl, statusEl, 'Import link'));
        actions.appendChild(copyLinkBtn);

        const copyPayloadBtn = document.createElement('button');
        copyPayloadBtn.type = 'button';
        copyPayloadBtn.className = 'btn-small';
        copyPayloadBtn.innerHTML = '<i class="fas fa-copy"></i> Copy Import Data';
        copyPayloadBtn.addEventListener('click', () => copyHandoffText(handoff.rawPayload, statusEl, 'Import data'));
        actions.appendChild(copyPayloadBtn);

        if (navigator.share) {
            const shareBtn = document.createElement('button');
            shareBtn.type = 'button';
            shareBtn.className = 'btn-small';
            shareBtn.innerHTML = '<i class="fas fa-share-alt"></i> Share';
            shareBtn.addEventListener('click', () => {
                navigator.share({
                    title: '14-High game hand-off',
                    text: 'Open this link to import the 14-High game.',
                    url: handoff.importUrl
                }).catch(err => {
                    if (err && err.name !== 'AbortError') {
                        console.error('Share failed:', err);
                        setHandoffStatus(statusEl, 'Share failed. Try Copy Link instead.', 'error');
                    }
                });
            });
            actions.appendChild(shareBtn);
        }

        container.appendChild(actions);

        const payloadText = document.createElement('textarea');
        payloadText.className = 'handoff-payload';
        payloadText.readOnly = true;
        payloadText.value = handoff.rawPayload;
        payloadText.setAttribute('aria-label', 'Raw hand-off import data');
        container.appendChild(payloadText);

    } catch (err) {
        console.error('QR generation error:', err);
        container.innerHTML = `
            <div style="text-align: center; color: var(--danger); padding: 1rem;">
                <i class="fas fa-times-circle" style="font-size: 2rem; margin-bottom: 0.5rem;"></i>
                <p><strong>QR code generation failed</strong></p>
                <p style="font-size: 0.9rem; margin-top: 0.5rem;">
                    Error: ${escapeHtml(err.message || 'Unknown error')}<br>
                    Please try again or start a new game.
                </p>
            </div>
        `;
    }

    modal.classList.add('active');
}

function parseCompressedHandoffState(compressed) {
    if (String(compressed).length > HANDOFF_MAX_COMPRESSED_LENGTH) {
        throw new Error('Import data is too large.');
    }
    const jsonStr = decompressHandoffData(compressed);
    if (!jsonStr) {
        throw new Error('Could not read compressed game data.');
    }
    return JSON.parse(jsonStr);
}

function parseHandoffImportText(decodedText) {
    const text = String(decodedText || '').trim();
    if (!text) {
        throw new Error('Empty QR code.');
    }

    const importParam = getImportParamFromText(text);
    if (importParam) {
        return parseCompressedHandoffState(importParam);
    }

    if (text.startsWith(HANDOFF_COMPRESSED_PREFIX)) {
        return parseCompressedHandoffState(text.slice(HANDOFF_COMPRESSED_PREFIX.length));
    }

    if (text.startsWith('14HIGH:')) {
        if (text.length > HANDOFF_MAX_JSON_LENGTH) throw new Error('Import data is too large.');
        return JSON.parse(text.slice(7));
    }

    throw new Error('Not a 14-High game QR code.');
}

function getImportParamFromText(text) {
    try {
        const url = new URL(text, window.location.href);
        return url.searchParams.get('import');
    } catch (err) {
        return null;
    }
}

function normalizeImportedGameState(parsed) {
    if (!isPlainObject(parsed) || !Array.isArray(parsed.players) || typeof parsed.gameStarted !== 'boolean') {
        throw new Error('Invalid game data format. Missing required fields.');
    }

    const state = sanitizeGameState(parsed);
    if (state.gameStarted && state.players.length < 2) {
        throw new Error('Imported games need at least 2 players.');
    }
    return state;
}

function importOfflineGameState(parsed) {
    offlineState = normalizeImportedGameState(parsed);
    saveOfflineState();
    return offlineState;
}

function getImportSuccessMessage(state) {
    const players = Array.isArray(state.players) ? state.players : [];
    return `Game imported successfully! ${players.length} players, Round ${state.currentRound || 1}`;
}

function finishHandoffImport(decodedText, options = {}) {
    const { statusEl, modal, source = 'paste' } = options;
    let message;
    try {
        const parsed = parseHandoffImportText(decodedText);
        const importedState = importOfflineGameState(parsed);
        message = getImportSuccessMessage(importedState);
        setHandoffStatus(statusEl, `${message} Loading...`, 'success');
        showHandoffImportNotice(message, 'success');
        trackAnalyticsEvent('handoff_imported', {
            import_source: source,
            player_count: importedState.players.length,
            round_number: importedState.currentRound
        });
    } catch (err) {
        const errorMessage = err.message || 'Failed to import game data.';
        setHandoffStatus(statusEl, errorMessage, 'error');
        showHandoffImportNotice(errorMessage, 'error');
        console.error('Import error:', err);
        return false;
    }

    // Apply the game immediately in this window. Camera shutdown must not
    // block rendering or trigger navigation to a browser outside the PWA.
    if (modal) modal.classList.remove('active');
    selectMode('offline');
    return true;
}

// Serialize cleanup across close/reopen, including a pending camera prompt.
let handoffScannerCleanup = Promise.resolve();
let closeHandoffScanner = null;

function showHandoffImportModal() {
    const modal = document.getElementById('handoff-import-modal');
    const closeBtn = document.getElementById('handoff-import-close');
    const statusEl = document.getElementById('handoff-import-status');
    const qrReaderDiv = document.getElementById('handoff-qr-reader');
    const pasteControls = document.getElementById('handoff-paste-controls');
    if (!modal || !qrReaderDiv || !pasteControls) return;
    if (closeHandoffScanner) closeHandoffScanner();
    setHandoffStatus(statusEl, 'Starting camera… Allow camera access to scan inside the app.');
    pasteControls.innerHTML = '';
    modal.classList.add('active');
    let scanner;
    let closed = false;
    let completed = false;
    let startPromise;
    let stopPromise;
    const transfer = {};

    const stopScanner = () => {
        if (!stopPromise) {
            stopPromise = Promise.resolve(startPromise).catch(() => {}).then(async () => {
                // start() resolves before the video fires "playing"; isScanning
                // is still false then, even though the camera is already owned.
                if (scanner && scanner.getState() !== Html5QrcodeScannerState.NOT_STARTED) await scanner.stop();
                if (scanner) scanner.clear();
            }).catch(err => console.warn('Camera cleanup failed:', err));
        }
        return stopPromise;
    };
    const close = () => {
        if (closed) return;
        closed = true;
        modal.classList.remove('active');
        window.removeEventListener('pagehide', close);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        handoffScannerCleanup = stopScanner();
        if (closeHandoffScanner === close) closeHandoffScanner = null;
    };
    const onVisibilityChange = () => { if (document.hidden) close(); };
    closeHandoffScanner = close;
    closeBtn.onclick = close;
    modal.onclick = e => { if (e.target === modal) close(); };
    window.addEventListener('pagehide', close);
    document.addEventListener('visibilitychange', onVisibilityChange);

    const acceptText = (text, source) => {
        if (closed || completed) return;
        try {
            const result = collectHandoffQRFrame(String(text || '').trim(), transfer);
            if (!result.payload) {
                setHandoffStatus(statusEl, `Scanned ${result.received} of ${result.count} parts. Keep the camera pointed at the codes.`, 'success');
                return;
            }
            completed = finishHandoffImport(result.payload, { statusEl, modal, source });
            if (completed) close();
        } catch (err) {
            setHandoffStatus(statusEl, err.message || 'Could not read game QR code.', 'error');
        }
    };

    const controls = document.createElement('div');
    controls.className = 'handoff-import-controls';
    const pasteInput = document.createElement('textarea');
    pasteInput.id = 'handoff-paste-input';
    pasteInput.placeholder = 'Paste a 14-High import link or import data';
    pasteInput.setAttribute('aria-label', 'Paste hand-off import link or data');
    controls.appendChild(pasteInput);
    const importPasteBtn = document.createElement('button');
    importPasteBtn.type = 'button';
    importPasteBtn.id = 'handoff-paste-import-btn';
    importPasteBtn.className = 'btn-small';
    importPasteBtn.textContent = 'Import Pasted Data';
    importPasteBtn.addEventListener('click', () => acceptText(pasteInput.value, 'paste'));
    controls.appendChild(importPasteBtn);
    pasteControls.appendChild(controls);

    const previousCleanup = handoffScannerCleanup;
    startPromise = previousCleanup.then(async () => {
        if (closed) return;
        qrReaderDiv.innerHTML = '';
        if (typeof Html5Qrcode === 'undefined') throw new Error('QR scanner could not load.');
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            throw new Error('Camera access requires HTTPS and a supported browser.');
        }
        scanner = new Html5Qrcode('handoff-qr-reader', {
            formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
            useBarCodeDetectorIfSupported: false,
            verbose: false
        });
        // Scan the entire video: a cropped box cuts off dense codes when
        // the phone is close enough to focus. Request rear-camera HD input.
        await scanner.start({ facingMode: 'environment' }, {
            fps: 10,
            disableFlip: false,
            videoConstraints: { facingMode: { ideal: 'environment' },
                width: { ideal: 1920 }, height: { ideal: 1080 } }
        }, text => acceptText(text, 'qr'), () => {});
        if (!closed && !completed) {
            setHandoffStatus(statusEl, 'Point the camera at the whole QR code. The game opens here automatically.');
        }
    }).catch(err => {
        console.warn('Camera start failed:', err);
        if (!closed && !completed) {
            setHandoffStatus(statusEl, `Camera unavailable: ${err.message || err}. Allow camera access and reopen Import from QR, or paste import data below.`, 'error');
        }
    });
}
